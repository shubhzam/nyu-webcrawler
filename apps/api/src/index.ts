import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import crawlRouter from './routes/crawl'
import jobRouter from './routes/job'

const app = express()
const port = process.env.PORT || 3000

// parse incoming json bodies
app.use(express.json())

// allow requests from the frontend
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3001' }))

// health check - confirms the server is up
app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

app.use('/api/crawl', crawlRouter)
app.use('/api/crawl/job', jobRouter)



app.listen(port, () => {
  console.log(`api running on port ${port}`)
})