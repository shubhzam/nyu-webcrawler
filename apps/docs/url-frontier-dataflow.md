# URL Frontier — Data Flow

> How data moves through the system when a crawl job runs. Feature 2 wraps
> feature 1's `crawl()` function — it doesn't replace it. The frontier is
> the engine that drives repeated calls to the same stable core.

---

## Components in play (feature 2)

- **Client** — curl/Postman now; dashboard later.
- **Express API** — two new routes: `POST /api/crawl/job`, `GET /api/crawl/job/:jobId`
- **Frontier service** — manages the Redis queue and runs the worker loop.
- **crawl service** — feature 1's `crawl(url)` — called unchanged.
- **Redis** — LIST per job (the frontier queue) + STRING counter (pages crawled).
- **Postgres** — persists crawled pages and links (unchanged from feature 1).

---

## Request lifecycle — POST /api/crawl/job

```
Client
  │  POST /api/crawl/job { url, maxDepth, maxPages }
  ▼
Express Router → Controller
  │ zod validate ──✗──▶ 400 invalid_url
  │ ✓
  ▼
FrontierService.startJob(url, maxDepth, maxPages)
  │ 1. generate jobId (cuid)
  │ 2. RPUSH frontier:<jobId> { url, depth: 0 }
  │ 3. SET frontier:<jobId>:count 0
  │ 4. kick off worker loop (async, non-blocking)
  ▼
202 { jobId, status: "started", seedUrl }

  [worker loop runs in background]
```

---

## Worker loop — the BFS crawl

```
FrontierService.runWorker(jobId, maxDepth, maxPages)
  │
  ┌─────────────────────────────────────┐
  │  loop                               │
  │    count = GET frontier:<jobId>:count│
  │    if count >= maxPages → break     │
  │                                     │
  │    item = BLPOP frontier:<jobId> 5s │
  │    if nil (timeout) → continue      │
  │                                     │
  │    { url, depth } = parse item      │
  │    if depth > maxDepth → continue   │
  │                                     │
  │    try                              │
  │      { links } = await crawl(url)   │──▶ fetch → parse → Postgres
  │      INCR frontier:<jobId>:count    │
  │      for each link:                 │
  │        RPUSH frontier:<jobId>       │
  │               { url: link,          │
  │                 depth: depth+1 }    │
  │    catch                            │
  │      log error, continue            │
  └─────────────────────────────────────┘
  │
  DEL frontier:<jobId>
  DEL frontier:<jobId>:count
  log "job done"
```

---

## Request lifecycle — GET /api/crawl/job/:jobId

```
Client
  │  GET /api/crawl/job/clx123
  ▼
Express Router → Controller
  │
  FrontierService.getJobStatus(jobId)
  │ 1. GET frontier:<jobId>:count    → pagesCrawled
  │ 2. LLEN frontier:<jobId>         → queueSize
  │ 3. if count key missing → "not_found"
  │ 4. if queueSize == 0 and worker done → "done"
  │    else → "running"
  ▼
200 { jobId, status, pagesCrawled, queueSize }
```

---

## Full picture — what's in each store after a crawl

```
Redis (ephemeral — gone after job completes):
  frontier:clx123         LIST  []          (drained)
  frontier:clx123:count   STRING "47"       (deleted after job)

Postgres (permanent):
  Page table:
    id: "cmq..." url: "https://www.nyu.edu"          depth implicitly 0
    id: "cmq..." url: "https://www.nyu.edu/about"    depth implicitly 1
    id: "cmq..." url: "https://www.nyu.edu/research" depth implicitly 1
    ... (up to maxPages rows)

  Link table:
    fromPageId → toUrl (edges of the crawl graph)
    ... (potentially thousands of edges)
```

---

## Where features 3 and 4 splice in

```
Worker loop (today):
  item = BLPOP frontier
  crawl(url)
  enqueue links

Worker loop (after feature 3 — dedup):
  item = BLPOP frontier
  if Redis SET contains url → skip          ← "URL Seen?" check
  crawl(url)
  if content hash already seen → skip store ← "Content Seen?" check
  SADD seen-urls url
  enqueue links

Worker loop (after feature 4 — politeness):
  item = BLPOP frontier
  host = extract hostname from url
  wait until per-host rate limit allows     ← Redis TTL key per host
  check robots.txt for host                 ← cached in Redis
  crawl(url)
  enqueue links
```

**The key insight:** the worker loop is the only thing that changes between
features 2, 3, and 4. The `crawl()` function stays identical. Each feature
adds one guard to the loop — it never rewrites the core.

---

## Sequence diagram (abbreviated)

```
Client          API           FrontierService      Redis         crawl()      Postgres
  │               │                 │                │               │            │
  │ POST /job     │                 │                │               │            │
  │──────────────▶│                 │                │               │            │
  │               │ startJob()      │                │               │            │
  │               │────────────────▶│                │               │            │
  │               │                 │ RPUSH seed     │               │            │
  │               │                 │───────────────▶│               │            │
  │               │                 │ runWorker()    │               │            │
  │               │                 │─────┐          │               │            │
  │  202 jobId    │                 │     │ (async)  │               │            │
  │◀──────────────│                 │     ▼          │               │            │
  │               │                 │ BLPOP          │               │            │
  │               │                 │───────────────▶│               │            │
  │               │                 │◀───────────────│               │            │
  │               │                 │ crawl(url)     │               │            │
  │               │                 │───────────────────────────────▶│            │
  │               │                 │                │               │ upsert     │
  │               │                 │                │               │───────────▶│
  │               │                 │◀───────────────────────────────│            │
  │               │                 │ RPUSH links    │               │            │
  │               │                 │───────────────▶│               │            │
  │               │                 │ INCR count     │               │            │
  │               │                 │───────────────▶│               │            │
  │               │                 │ [loop...]      │               │            │
  │               │                 │                │               │            │
  │ GET /job/:id  │                 │                │               │            │
  │──────────────▶│                 │                │               │            │
  │               │ getStatus()     │                │               │            │
  │               │────────────────▶│                │               │            │
  │               │                 │ GET count      │               │            │
  │               │                 │───────────────▶│               │            │
  │               │                 │ LLEN queue     │               │            │
  │               │                 │───────────────▶│               │            │
  │  200 status   │                 │◀───────────────│               │            │
  │◀──────────────│                 │                │               │            │
```
