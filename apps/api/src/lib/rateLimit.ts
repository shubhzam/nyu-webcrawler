import redis from './redis'

const DEFAULT_CRAWL_DELAY = 2 // seconds between requests to the same host

// check if a host is still in its cooldown window
export async function isOnCooldown(hostname: string): Promise<boolean> {
  const result = await redis.get(`crawl-delay:${hostname}`)
  return result !== null
}

// set cooldown for a host after crawling it
export async function setCooldown(
  hostname: string,
  delaySeconds = DEFAULT_CRAWL_DELAY
): Promise<void> {
  await redis.set(`crawl-delay:${hostname}`, '1', 'EX', delaySeconds)
}