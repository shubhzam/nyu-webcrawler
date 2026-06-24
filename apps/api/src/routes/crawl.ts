import { Router } from 'express'
import { z } from 'zod'
import { crawl } from '../services/crawl.service'

const router = Router()

// validate the request body shape
const crawlSchema = z.object({
  url: z.string().url(),
})

router.post('/', async (req, res) => {
  // parse and validate the body
  const result = crawlSchema.safeParse(req.body)
  if (!result.success) {
    res.status(400).json({
      error: { code: 'invalid_url', message: 'url must be a valid http(s) URL' },
    })
    return
  }

  try {
    const data = await crawl(result.data.url)
    res.status(201).json(data)
  } catch (err: unknown) {
    const e = err as { code?: string }
    if (e.code === 'fetch_timeout') {
      res.status(504).json({ error: { code: 'fetch_timeout', message: 'target URL timed out' } })
    } else if (e.code === 'fetch_error') {
      res.status(502).json({ error: { code: 'fetch_error', message: 'could not reach target URL' } })
    } else {
      res.status(500).json({ error: { code: 'internal', message: 'something went wrong' } })
    }
  }
})

export default router