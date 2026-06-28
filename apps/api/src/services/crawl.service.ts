import * as cheerio from 'cheerio'
import { createHash } from 'crypto'
import prisma from '../lib/prisma'

// how long to wait for a page to respond before giving up
const FETCH_TIMEOUT_MS = 10_000

// max body size we'll read - protects against huge pages OOMing the process
const MAX_BODY_BYTES = 5 * 1024 * 1024

// normalize a discovered href into an absolute url, returns null if we should skip it
function normalizeUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base)
    // only keep http and https - drop mailto:, tel:, javascript:, etc.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    // strip fragments - #section is same page, not a new url
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

export async function crawl(url: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'WebCrawler/1.0 (learning project)' },
      redirect: 'follow',
    })
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    throw { code: isTimeout ? 'fetch_timeout' : 'fetch_error', cause: err }
  } finally {
    clearTimeout(timeout)
  }

  const finalUrl = response.url
  const statusCode = response.status
  const contentType = response.headers.get('content-type') ?? undefined

  // if not html, persist a minimal page record and return early with no links
  const isHtml = contentType?.includes('text/html') ?? false
  if (!response.ok || !isHtml) {
    const page = await prisma.page.upsert({
      where: { url },
      create: { url, finalUrl, statusCode, contentType },
      update: { finalUrl, statusCode, contentType, fetchedAt: new Date() },
    })
    return { page, links: [] }
  }

  // read body with a size cap so one giant page can't OOM us
  const buffer = await response.arrayBuffer()
  const html = new TextDecoder().decode(buffer.slice(0, MAX_BODY_BYTES))

  // compute content hash for dedup - md5 is fast and collision risk is negligible
  const contentHash = createHash('md5').update(html).digest('hex')

  // content seen? check - if we've stored this exact html before, skip storing
  const existing = await prisma.page.findFirst({ where: { contentHash } })
  if (existing) {
    console.log(`content already seen for ${url} (matches ${existing.url}), skipping store`)

    // still parse and return links - they might lead to pages we haven't seen
    const $ = cheerio.load(html)
    const linkSet = new Set<string>()
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href')
      if (!href) return
      const normalized = normalizeUrl(href, finalUrl)
      if (normalized) linkSet.add(normalized)
    })
    const links = Array.from(linkSet)
    return { page: existing, links, linkCount: links.length }
  }

  // parse title and all hrefs with cheerio
  const $ = cheerio.load(html)
  const title = $('title').first().text().trim() || undefined

  // extract, normalize, and dedupe links in one pass
  const linkSet = new Set<string>()
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return
    const normalized = normalizeUrl(href, finalUrl)
    if (normalized) linkSet.add(normalized)
  })
  const links = Array.from(linkSet)

  // persist page and links in one transaction
  const page = await prisma.$transaction(async (tx) => {
    const savedPage = await tx.page.upsert({
      where: { url },
      create: { url, finalUrl, statusCode, contentType, title, html, contentHash },
      update: { finalUrl, statusCode, contentType, title, html, contentHash, fetchedAt: new Date() },
    })

    // replace links on every crawl - clean slate so removed links don't persist
    await tx.link.deleteMany({ where: { fromPageId: savedPage.id } })
    if (links.length > 0) {
      await tx.link.createMany({
        data: links.map((toUrl) => ({ fromPageId: savedPage.id, toUrl })),
        skipDuplicates: true,
      })
    }

    return savedPage
  })

  return { page, links, linkCount: links.length }
}