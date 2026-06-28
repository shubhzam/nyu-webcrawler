import { createId } from '@paralleldrive/cuid2'
import redis from '../lib/redis'
import { crawl } from './crawl.service'

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
async function runWorker(jobId: string, maxDepth: number, maxPages: number) {
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
      // queue empty and timeout fired - we're done
      console.log(`job ${jobId} queue empty, stopping`)
      break
    }

    // result is [key, value] from blpop
    const { url, depth } = JSON.parse(result[1]!)

    // skip if too deep
    if (depth > maxDepth) continue

    // url seen? check - skip if we've already crawled this url in this job
    const seen = await redis.sismember(seenKey(jobId), url)
    if (seen) {
      console.log(`skipping seen url: ${url}`)
      continue
    }

    try {
      console.log(`crawling depth=${depth} url=${url}`)
      const { links, page } = await crawl(url)

      // mark the final url as seen (post-redirect) so we don't re-crawl it
      await redis.sadd(seenKey(jobId), page.finalUrl)

      // increment pages crawled counter
      await redis.incr(countKey(jobId))

      // enqueue all discovered links at depth + 1
      for (const link of links) {
        await enqueue(jobId, link, depth + 1)
      }
    } catch (err: unknown) {
      // one bad url shouldn't stop the whole crawl
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
  maxPages = MAX_PAGES
) {
  const jobId = createId()

  // seed the frontier with the starting url at depth 0
  await enqueue(jobId, seedUrl, 0)
  await redis.set(countKey(jobId), 0)

  // start worker without awaiting - runs in background
  runWorker(jobId, maxDepth, maxPages).catch((err) => {
    console.error(`worker crashed for job ${jobId}: ${err.message}`)
  })

  return { jobId, seedUrl }
}

export async function getJobStatus(jobId: string) {
  const count = await redis.get(countKey(jobId))

  // if count key doesn't exist, job is not found or already cleaned up
  if (count === null) {
    return { jobId, status: 'not_found' as const }
  }

  const queueSize = await redis.llen(frontierKey(jobId))
  const pagesCrawled = Number(count)
  const status = queueSize === 0 ? 'done' as const : 'running' as const

  return { jobId, status, pagesCrawled, queueSize }
}