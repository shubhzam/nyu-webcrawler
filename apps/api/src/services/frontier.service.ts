import { createId } from '@paralleldrive/cuid2'
import redis from '../lib/redis'
import { crawl } from './crawl.service'
import { isAllowedByRobots } from '../lib/robots'
import { isOnCooldown, setCooldown } from '../lib/rateLimit'

const MAX_DEPTH = 3
const MAX_PAGES = 100

// keys for this job's redis data
function frontierKey(jobId: string) {
  return `frontier:${jobId}`
}
function countKey(jobId: string) {
  return `frontier:${jobId}:count`
}
function seenKey(jobId: string) {
  return `seen-urls:${jobId}`
}

// add a url to the frontier queue
async function enqueue(jobId: string, url: string, depth: number) {
  await redis.rpush(frontierKey(jobId), JSON.stringify({ url, depth }))
}

// the worker loop - runs until queue is empty or limits are hit
async function runWorker(
  jobId: string,
  maxDepth: number,
  maxPages: number,
  crawlDelay: number
) {
  console.log(`worker started for job ${jobId}`)

  while (true) {
    // check page cap before dequeuing
    const count = Number(await redis.get(countKey(jobId))) || 0
    if (count >= maxPages) {
      console.log(`job ${jobId} hit max pages (${maxPages}), stopping`)
      break
    }

    // blocking pop - waits up to 5s if queue is empty
    const result = await redis.blpop(frontierKey(jobId), 5)
    if (!result) {
      console.log(`job ${jobId} queue empty, stopping`)
      break
    }

    const { url, depth } = JSON.parse(result[1]!)

    // skip if too deep
    if (depth > maxDepth) continue

    // url seen? check - skip if already crawled this job
    const seen = await redis.sismember(seenKey(jobId), url)
    if (seen) {
      console.log(`skipping seen url: ${url}`)
      continue
    }

    // robots.txt check - skip if disallowed
    const allowed = await isAllowedByRobots(url)
    if (!allowed) {
      console.log(`robots.txt disallows: ${url}`)
      continue
    }

    // rate limit check - re-enqueue if host is on cooldown
    const hostname = new URL(url).hostname
    const onCooldown = await isOnCooldown(hostname)
    if (onCooldown) {
      console.log(`host ${hostname} on cooldown, re-enqueueing: ${url}`)
      await enqueue(jobId, url, depth)
      continue
    }

    // set cooldown before crawling so no other iteration jumps in
    await setCooldown(hostname, crawlDelay)

    try {
      console.log(`crawling depth=${depth} url=${url}`)
      const { links, page } = await crawl(url)

      // mark the final url as seen (post-redirect)
      await redis.sadd(seenKey(jobId), page.finalUrl)

      // increment pages crawled counter
      await redis.incr(countKey(jobId))

      // enqueue all discovered links at depth + 1
      for (const link of links) {
        await enqueue(jobId, link, depth + 1)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`crawl failed for ${url}: ${message}`)
    }
  }

  // cleanup redis keys when done
  await redis.del(frontierKey(jobId))
  await redis.del(countKey(jobId))
  await redis.del(seenKey(jobId))
  console.log(`job ${jobId} complete`)
}

export async function startJob(
  seedUrl: string,
  maxDepth = MAX_DEPTH,
  maxPages = MAX_PAGES,
  crawlDelay = 2
) {
  const jobId = createId()

  // seed the frontier with the starting url at depth 0
  await enqueue(jobId, seedUrl, 0)
  await redis.set(countKey(jobId), 0)

  // start worker without awaiting - runs in background
  runWorker(jobId, maxDepth, maxPages, crawlDelay).catch((err) => {
    console.error(`worker crashed for job ${jobId}: ${err.message}`)
  })

  return { jobId, seedUrl }
}

export async function getJobStatus(jobId: string) {
  const count = await redis.get(countKey(jobId))

  if (count === null) {
    return { jobId, status: 'not_found' as const }
  }

  const queueSize = await redis.llen(frontierKey(jobId))
  const pagesCrawled = Number(count)
  const status = queueSize === 0 ? 'done' as const : 'running' as const

  return { jobId, status, pagesCrawled, queueSize }
}