import Redis from 'ioredis'

// single redis connection reused across the app
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
})

redis.on('error', (err) => {
  console.error(`redis connection error: ${err.message}`)
})

redis.on('connect', () => {
  console.log('redis connected')
})

export default redis