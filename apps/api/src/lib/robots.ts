import redis from './redis'

const ROBOTS_CACHE_TTL = 60 * 60 * 24 // 24 hours in seconds
const OUR_USER_AGENT = 'WebCrawler'

interface RobotsRules {
  disallow: string[]
  allow: string[]
  crawlDelay?: number
}

// parse robots.txt text into rules for our user agent
function parseRobots(text: string): RobotsRules {
  const lines = text.split('\n').map(l => l.trim())

  // collect all blocks keyed by user-agent
  const blocks: Record<string, RobotsRules> = {}
  let currentAgents: string[] = []

  for (const line of lines) {
    // skip comments and empty lines
    if (!line || line.startsWith('#')) continue

    const [field, ...rest] = line.split(':')
    const key = field?.trim().toLowerCase()
    const value = rest.join(':').trim()

    if (key === 'user-agent') {
      currentAgents = [...currentAgents, value.toLowerCase()]
      // initialize block for each agent if not exists
      for (const agent of currentAgents) {
        if (!blocks[agent]) blocks[agent] = { disallow: [], allow: [] }
      }
    } else if (key === 'disallow') {
      for (const agent of currentAgents) {
        blocks[agent]?.disallow.push(value)
      }
    } else if (key === 'allow') {
      for (const agent of currentAgents) {
        blocks[agent]?.allow.push(value)
      }
    } else if (key === 'crawl-delay') {
      const delay = Number(value)
      if (!isNaN(delay)) {
        for (const agent of currentAgents) {
          if (blocks[agent]) blocks[agent].crawlDelay = delay
        }
      }
    } else {
      // blank line or unknown field resets the current agent group
      currentAgents = []
    }
  }

  // find rules for our agent - specific match wins over wildcard
  const ourAgent = OUR_USER_AGENT.toLowerCase()
  return blocks[ourAgent] ?? blocks['*'] ?? { disallow: [], allow: [] }
}

// check if a path is allowed by the rules
function isPathAllowed(path: string, rules: RobotsRules): boolean {
  // check allow rules first - they take precedence if more specific
  for (const allowed of rules.allow) {
    if (allowed && path.startsWith(allowed)) return true
  }

  // check disallow rules
  for (const disallowed of rules.disallow) {
    // empty disallow means allow all
    if (!disallowed) continue
    // disallow: / means block everything
    if (path.startsWith(disallowed)) return false
  }

  return true
}

// fetch and cache robots.txt for a hostname
async function fetchRobots(hostname: string): Promise<RobotsRules> {
  try {
    const response = await fetch(`https://${hostname}/robots.txt`, {
      headers: { 'User-Agent': `${OUR_USER_AGENT}/1.0 (learning project)` },
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      // no robots.txt or error - allow all
      return { disallow: [], allow: [] }
    }

    const text = await response.text()
    return parseRobots(text)
  } catch {
    // network error fetching robots.txt - allow all, don't block the crawl
    return { disallow: [], allow: [] }
  }
}

// main export - check if a url is allowed by robots.txt
export async function isAllowedByRobots(url: string): Promise<boolean> {
  const parsed = new URL(url)
  const hostname = parsed.hostname
  const path = parsed.pathname

  const cacheKey = `robots:${hostname}`

  // check cache first
  const cached = await redis.get(cacheKey)
  if (cached) {
    const rules: RobotsRules = JSON.parse(cached)
    return isPathAllowed(path, rules)
  }

  // cache miss - fetch and cache
  const rules = await fetchRobots(hostname)
  await redis.set(cacheKey, JSON.stringify(rules), 'EX', ROBOTS_CACHE_TTL)

  return isPathAllowed(path, rules)
}