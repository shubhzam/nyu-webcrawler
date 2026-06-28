import { Router } from 'express'
import { z } from 'zod'
import { startJob, getJobStatus } from '../services/frontier.service'

const router = Router()

const startJobSchema = z.object({
  url: z.string().url(),
  maxDepth: z.number().int().min(1).max(10).optional(),
  maxPages: z.number().int().min(1).max(500).optional(),
  crawlDelay: z.number().min(0).max(30).optional(),
})

// start a new crawl job
router.post('/', async (req, res) => {
  const result = startJobSchema.safeParse(req.body)
  if (!result.success) {
    res.status(400).json({
      error: { code: 'invalid_url', message: 'url must be a valid http(s) URL' },
    })
    return
  }

  const { url, maxDepth, maxPages, crawlDelay } = result.data
  const job = await startJob(url, maxDepth, maxPages, crawlDelay)
  res.status(202).json({ ...job, status: 'started' })
})

// get status of a running or completed job
router.get('/:jobId', async (req, res) => {
  const jobId = req.params['jobId']!
  const status = await getJobStatus(jobId)
  res.json(status)
})

export default router