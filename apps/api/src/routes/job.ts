import { Router } from 'express'
import { z } from 'zod'
import { startJob, getJobStatus, stopJob, listJobs } from '../services/frontier.service'

const router = Router()

const startJobSchema = z.object({
  url: z.string().url(),
  maxDepth: z.number().int().min(1).max(10).optional(),
  maxPages: z.number().int().min(1).max(500).optional(),
  crawlDelay: z.number().min(0).max(30).optional(),
})

// list all jobs
router.get('/', async (req, res) => {
  const jobs = await listJobs()
  res.json({ jobs })
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
  res.status(202).json({ ...job, status: 'running' })
})

// get status of a job
router.get('/:jobId', async (req, res) => {
  const jobId = req.params['jobId']!
  const status = await getJobStatus(jobId)

  if (!status) {
    res.status(404).json({ error: { code: 'not_found', message: 'job not found' } })
    return
  }

  res.json(status)
})

// stop a running job
router.delete('/:jobId', async (req, res) => {
  const jobId = req.params['jobId']!
  const result = await stopJob(jobId)

  if (result.code === 'not_found') {
    res.status(404).json({ error: { code: 'not_found', message: 'job not found' } })
    return
  }

  if (result.code === 'not_running') {
    res.status(400).json({ error: { code: 'not_running', message: 'job is not running' } })
    return
  }

  res.status(202).json({ jobId, message: 'stop signal sent' })
})

export default router