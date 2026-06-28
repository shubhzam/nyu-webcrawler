# Politeness — Tech Spec

> **Feature 4 of the crawler.** The book states: *"Generally, a web crawler
> should avoid sending too many requests to the same hosting server within a
> short period. Sending too many requests is considered as 'impolite' or even
> treated as denial-of-service (DOS) attack."*
>
> **Maps to** Alex Yu Ch. 9 — Politeness section and Robots.txt section of
> the HTML Downloader deep dive.

---

## 1. Problem

Right now our crawler hits NYU's servers as fast as Node can await each
fetch. With `maxPages=100` that's ~100 requests in a few seconds to the
same host. That's rude at best, banned at worst.

Two separate concerns:

**Rate limiting** — don't hit the same host more than once every N seconds.
The book says *"download one page at a time from the same host. A delay can
be added between two download tasks."*

**robots.txt** — websites publish a file at `/robots.txt` that tells crawlers
which paths they're allowed to fetch. Ignoring it is both unethical and
gets you IP-banned. The book says *"before attempting to crawl a web site,
a crawler should check its corresponding robots.txt first and follow its rules."*

---

## 2. Approach

### Per-host rate limiting — Redis TTL key

Before crawling a URL, check if the host is on cooldown:

```
key: crawl-delay:<hostname>
type: STRING with TTL

GET crawl-delay:www.nyu.edu
→ exists  → host is on cooldown, re-enqueue url and skip
→ missing → ok to crawl, SET crawl-delay:www.nyu.edu EX 2
```

After crawling, set the key with a 2-second TTL. The key expires
automatically — no cleanup needed. Next request for the same host checks
if the key exists. If it does, we're still in the cooldown window.

**Why re-enqueue instead of sleep?**
Sleeping blocks the worker loop — no other URLs can be processed during
the wait. Re-enqueueing at the tail lets us process other hosts while
waiting for the cooldown to expire. More efficient, more polite across
multiple domains simultaneously.

**Why 2 seconds?**
Arbitrary conservative default. Production crawlers use the `Crawl-delay`
directive from `robots.txt` if present. We'll check for that too.

### robots.txt — cached in Redis

Fetch and parse `/robots.txt` for each host, cache the result:

```
key: robots:<hostname>
type: STRING (serialized rules)
TTL: 24 hours
```

Before crawling a URL:
1. Check `robots:<hostname>` in Redis
2. If missing → fetch `https://<hostname>/robots.txt`, parse, cache
3. Check if our `User-Agent` is allowed to access the path
4. If disallowed → skip URL entirely, log it

**robots.txt parsing:** We'll write a minimal parser — no npm package
needed. The format is simple:

```
User-agent: *
Disallow: /private/
Disallow: /admin/

User-agent: Googlebot
Disallow: /
```

Rules: find the `User-agent: *` block (applies to all crawlers).
For each `Disallow:` entry, check if the URL path starts with the
disallowed prefix. If yes → skip.

**Why cache in Redis?**
The book explicitly says: *"To avoid repeat downloads of robots.txt file,
we cache the results."* Fetching `/robots.txt` on every single page request
would double our request count. 24-hour TTL is standard — robots.txt
rarely changes.

**What if robots.txt doesn't exist?** 404 → treat as "allow all". That's
the standard convention.

### Where these checks live

Both go in the worker loop in `frontier.service.ts`, before `crawl()`:

```typescript
// worker loop (feature 4)
const { url, depth } = JSON.parse(result[1])

if (depth > maxDepth) continue
if (await isSeen(jobId, url)) continue       // feature 3

const hostname = new URL(url).hostname

// robots.txt check  ← NEW
const allowed = await isAllowedByRobots(url)
if (!allowed) {
  console.log(`robots.txt disallows: ${url}`)
  continue
}

// rate limit check  ← NEW
const onCooldown = await isOnCooldown(hostname)
if (onCooldown) {
  await enqueue(jobId, url, depth)           // re-enqueue at tail
  continue
}

// set cooldown before crawling
await setCooldown(hostname)

const { links, page } = await crawl(url)
```

---

## 3. Schema / API Contracts

### No Prisma changes

No new models or migrations needed.

### New Redis keys

```
crawl-delay:<hostname>    STRING with TTL (exists = on cooldown)
robots:<hostname>         STRING JSON-serialized rules, TTL 24h
```

### No API changes

Politeness is internal to the worker. `POST /api/crawl/job` accepts an
optional `crawlDelay` parameter (seconds, default 2):

```
POST /api/crawl/job
{ "url": "https://www.nyu.edu", "maxDepth": 2, "maxPages": 50, "crawlDelay": 2 }
```

---

## 4. Edge Cases

- **robots.txt fetch fails** (network error, timeout) → treat as "allow all",
  log a warning. Don't block the crawl over a missing robots file.
- **robots.txt returns non-200** → treat as "allow all".
- **`Crawl-delay` directive in robots.txt** → use it instead of our default
  if present. NYU may specify their own preferred delay.
- **Multiple User-agent blocks** → check `User-agent: *` (wildcard) and
  `User-agent: WebCrawler` (our agent name). Specific agent rules take
  precedence over wildcard.
- **Disallow: /** → entire site is disallowed. Skip all URLs for this host.
- **Disallow: (empty)** → explicitly allow everything. Counter-intuitive
  but standard.
- **Re-enqueue loop** — if ALL remaining URLs are on cooldown, the worker
  keeps re-enqueueing and popping the same URLs. The queue never empties.
  Guard: track re-enqueue count per URL; if a URL has been re-enqueued
  more than N times without being crawled, sleep briefly. Simple fix for
  a single-host crawl.
- **robots.txt for external hosts** (facebook.com, linkedin.com discovered
  as links) → still check robots. We might be disallowed. This is correct
  behaviour.

---

## 5. Trade-offs

| Decision | Chose | Gave up | Why |
|---|---|---|---|
| Rate limit mechanism | Redis TTL key | sleep() | non-blocking, other hosts processed during wait |
| robots.txt parsing | hand-rolled | `robots-parser` npm package | simple format, learn the protocol |
| robots.txt cache TTL | 24 hours | always fresh | standard convention, robots.txt rarely changes |
| robots.txt miss | allow all | block all | conservative allows; blocking would stop valid crawls |
| crawlDelay default | 2 seconds | 0 | polite default, overridable |

---

## 6. Definition of Done

- Crawl logs show `crawl-delay: skipping <host>, re-enqueueing` when
  hitting a host too fast.
- `nyu.edu/robots.txt` is fetched once and cached — not re-fetched for
  every page.
- Paths disallowed by `robots.txt` are skipped with a log message.
- Two consecutive requests to the same host are always ≥ `crawlDelay`
  seconds apart.
- Robots cache survives across multiple jobs (24h TTL).
