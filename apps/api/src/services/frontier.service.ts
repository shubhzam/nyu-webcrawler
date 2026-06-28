import { createId } from '@paralleldrive/cuid2'
import redis from '../lib/redis'
import prisma from '../lib/prisma'
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
function stopKey(jobId: string) {
  return `stop:${jobId}`
}

// add a url to the frontier queue
async function enqueue(jobId: string, url: string, depth: number) {
  await redis.rpush(frontierKey(jobId), JSON.stringify({ url, depth }))
}

// clean up all redis keys for a job
async function cleanupRedis(jobId: string) {
  await redis.del(frontierKey(jobId))
  await redis.del(countKey(jobId))
  await redis.del(seenKey(jobId))
  await redis.del(stopKey(jobId))
}

// the worker loop - runs until queue empty, limits hit, or stop signal
async function runWorker(
  jobId: string,
  maxDepth: number,
  maxPages: number,
  crawlDelay: number
) {
  console.log(`worker started for job ${jobId}`)

  try {
    while (true) {
      // check stop signal first - allows clean cancellation
      const stopSignal = await redis.get(stopKey(jobId))
      if (stopSignal) {
        console.log(`job ${jobId} received stop signal`)
        const finalCount = Number(await redis.get(countKey(jobId))) || 0
        await cleanupRedis(jobId)
        await prisma.crawlJob.update({
          where: { id: jobId },
          data: { status: 'STOPPED', pagesCrawled: finalCount, completedAt: new Date() },
        })
        return
      }

      // check page cap
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

      // url seen? check
      const seen = await redis.sismember(seenKey(jobId), url)
      if (seen) {
        console.log(`skipping seen url: ${url}`)
        continue
      }

      // robots.txt check
      const allowed = await isAllowedByRobots(url)
      if (!allowed) {
        console.log(`robots.txt disallows: ${url}`)
        continue
      }

      // rate limit check
      const hostname = new URL(url).hostname
      const onCooldown = await isOnCooldown(hostname)
      if (onCooldown) {
        console.log(`host ${hostname} on cooldown, re-enqueueing: ${url}`)
        await enqueue(jobId, url, depth)
        continue
      }

      // set cooldown before crawling
      await setCooldown(hostname, crawlDelay)

      try {
        console.log(`crawling depth=${depth} url=${url}`)
        const { links, page } = await crawl(url)

        // mark the final url as seen (post-redirect)
        await redis.sadd(seenKey(jobId), page.finalUrl)

        // increment pages crawled counter
        const newCount = await redis.incr(countKey(jobId))

        // sync pagesCrawled to postgres every 10 pages
        if (newCount % 10 === 0) {
          await prisma.crawlJob.update({
            where: { id: jobId },
            data: { pagesCrawled: newCount },
          })
        }

        // enqueue all discovered links at depth + 1
        for (const link of links) {
          await enqueue(jobId, link, depth + 1)
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`crawl failed for ${url}: ${message}`)
      }
    }

    // job completed naturally - final sync to postgres
    const finalCount = Number(await redis.get(countKey(jobId))) || 0
    await cleanupRedis(jobId)
    await prisma.crawlJob.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', pagesCrawled: finalCount, completedAt: new Date() },
    })
    console.log(`job ${jobId} complete`)

  } catch (err: unknown) {
    // unexpected worker crash - mark as failed
    const message = err instanceof Error ? err.message : String(err)
    console.error(`worker crashed for job ${jobId}: ${message}`)
    const finalCount = Number(await redis.get(countKey(jobId))) || 0
    await cleanupRedis(jobId)
    await prisma.crawlJob.update({
      where: { id: jobId },
      data: { status: 'FAILED', pagesCrawled: finalCount, completedAt: new Date(), error: message },
    })
  }
}

export async function startJob(
  seedUrl: string,
  maxDepth = MAX_DEPTH,
  maxPages = MAX_PAGES,
  crawlDelay = 2
) {
  const jobId = createId()

  // create persistent job record first
  await prisma.crawlJob.create({
    data: {
      id: jobId,
      seedUrl,
      maxDepth,
      maxPages,
      crawlDelay,
    },
  })

  // seed the frontier
  await enqueue(jobId, seedUrl, 0)
  await redis.set(countKey(jobId), 0)

  // start worker without awaiting - runs in background
  runWorker(jobId, maxDepth, maxPages, crawlDelay).catch((err) => {
    console.error(`unhandled worker error for job ${jobId}: ${err.message}`)
  })

  return { jobId, seedUrl }
}

export async function getJobStatus(jobId: string) {
  const job = await prisma.crawlJob.findUnique({ where: { id: jobId } })

  if (!job) {
    return null
  }

  // for running jobs, get live counts from redis
  if (job.status === 'RUNNING') {
    const redisCount = Number(await redis.get(countKey(jobId))) || 0
    const queueSize = await redis.llen(frontierKey(jobId))
    return {
      jobId: job.id,
      status: 'running' as const,
      seedUrl: job.seedUrl,
      pagesCrawled: redisCount,
      queueSize,
      startedAt: job.startedAt,
    }
  }

  // for completed/failed/stopped jobs, everything is in postgres
  return {
    jobId: job.id,
    status: job.status.toLowerCase() as 'completed' | 'failed' | 'stopped',
    seedUrl: job.seedUrl,
    pagesCrawled: job.pagesCrawled,
    queueSize: 0,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
  }
}

export async function stopJob(jobId: string) {
  const job = await prisma.crawlJob.findUnique({ where: { id: jobId } })

  if (!job) return { code: 'not_found' as const }
  if (job.status !== 'RUNNING') return { code: 'not_running' as const }

  // set stop signal - worker picks it up on next iteration
  await redis.set(stopKey(jobId), '1', 'EX', 3600)
  return { code: 'ok' as const }
}

export async function listJobs() {
  const jobs = await prisma.crawlJob.findMany({
    orderBy: { startedAt: 'desc' },
    take: 20,
  })

  return jobs.map(job => ({
    jobId: job.id,
    seedUrl: job.seedUrl,
    status: job.status.toLowerCase(),
    pagesCrawled: job.pagesCrawled,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  }))
}