# URL Frontier — Tech Spec

> **Feature 2 of the crawler.** The URL Frontier is the BFS queue that turns a
> one-shot crawl into a continuous crawl. It takes the 43 links we discovered
> in feature 1, queues them up, and drives the crawler through them
> systematically — one page at a time.
>
> **Maps to** Alex Yu, *System Design Interview Vol. 1*, Ch. 9. The book
> describes the frontier as: *"Most modern web crawlers split the crawl state
> into two: to be downloaded and already downloaded. The component that stores
> URLs to be downloaded is called the URL Frontier. You can refer to this as a
> First-in-First-out (FIFO) queue."*

---

## 1. Problem

After crawling `nyu.edu`, we have 43 discovered links sitting in the `Link`
table. Nothing processes them. The crawler stops. Feature 2 fixes that: a
worker continuously pulls URLs from a queue, calls `crawl()`, and enqueues
the newly discovered links — repeating until the queue is empty or a depth
limit is hit.

**Deliberately out of scope:**
- Per-host rate limiting / robots.txt → **feature 4 (politeness)**
- "Have we seen this URL before?" → **feature 3 (dedup)**. For now the worker
  will re-crawl already-visited URLs. That's intentional — dedup wraps the
  frontier, it doesn't live inside it.
- Priority queues (PageRank-based ordering) → the book covers this but it's an
  optimization. We use plain FIFO BFS for now.
- Distributed crawl / multiple workers → single worker loop for this build.

---

## 2. Approach

### Queue backend — Redis LIST

The book notes the frontier needs to be durable (survives process restarts)
and fast. Redis LIST is the right primitive:

- `RPUSH frontier <url>` — enqueue to the tail
- `BLPOP frontier 5` — blocking dequeue from the head (blocks up to 5s if
  empty, then returns nil so the worker can check a stop signal)

This is a FIFO queue. BFS — the book's recommended traversal — falls out
naturally from FIFO: seed URL first, then its children, then their children.

**Why not Postgres as the queue?** You could use a `pending_urls` table with
`SELECT ... FOR UPDATE SKIP LOCKED`. That works and is simpler to operate
(one fewer service). Trade-off: Postgres queues are ~10-100x slower than
Redis for high-throughput polling, and `SKIP LOCKED` adds lock contention.
For a learning project with one worker this doesn't matter, but Redis is
the canonical choice and we already have it running from docker-compose.

**Why not Bull/BullMQ?** BullMQ is a full job queue library built on Redis.
It gives you retries, concurrency, dashboards, delayed jobs. Trade-off:
it abstracts away the Redis primitives so you never learn how the queue
actually works. We're building the queue ourselves with raw Redis commands —
same educational value as building the `crawl()` function directly instead
of reaching for a scraping library.

### Worker loop

```
while running:
  url = BLPOP frontier (blocking, 5s timeout)
  if url is nil: continue   # queue empty, wait
  crawl(url)                # feature 1's crawl() — unchanged
  for each link in result:
    RPUSH frontier link     # enqueue discovered links
```

The worker runs as a long-lived async loop inside the same Node process for
now. Feature 5 (crawl jobs) will promote it to a proper background job with
start/stop controls.

### Crawl job trigger

`POST /api/crawl/job` — seeds the frontier with a URL and starts the worker
loop. Returns immediately with a `jobId` (just a cuid for now) while the
crawl runs in the background.

### Depth limiting

The book doesn't prescribe a specific mechanism — it just says to limit
crawl depth to avoid infinite traversal. We track depth by storing it in
the Redis queue as a JSON payload: `{ url, depth }`. The worker drops any
URL where `depth > MAX_DEPTH` (default: 3 for nyu.edu — deep enough to
explore the site, shallow enough to finish in reasonable time).

### Max pages cap

A hard cap on total pages crawled per job (`MAX_PAGES`, default: 100).
Guards against the queue growing unboundedly on a large site before we
have dedup in place.

---

## 3. Schema / API Contracts

### No new Prisma models needed

The frontier lives entirely in Redis. The `Page` and `Link` tables from
feature 1 are the persistent record. The Redis LIST is ephemeral — if the
process restarts mid-crawl, the queue resets. That's acceptable for now;
feature 5 (jobs) adds persistence.

### Redis keys

```
frontier:<jobId>        LIST of JSON { url, depth }
frontier:<jobId>:count  STRING, pages crawled so far (INCR)
```

Namespacing by `jobId` means multiple concurrent crawl jobs don't share
a queue. Cleanup: `DEL frontier:<jobId>` and `frontier:<jobId>:count`
after the job finishes.

### HTTP contract

```
POST /api/crawl/job
Content-Type: application/json

Request:
  { "url": "https://www.nyu.edu", "maxDepth": 3, "maxPages": 100 }

202 Accepted:
  { "jobId": "clx...", "status": "started", "seedUrl": "https://www.nyu.edu" }
```

`202` not `201` — the job is accepted and running, not complete. The resource
(crawled pages) isn't created yet.

```
GET /api/crawl/job/:jobId
200 OK:
  {
    "jobId": "clx...",
    "status": "running" | "done" | "not_found",
    "pagesCrawled": 42,
    "queueSize": 7
  }
```

| Status | code | When |
|--------|------|------|
| 400 | `invalid_url` | seed URL failed zod validation |
| 409 | `job_running` | a job with this jobId is already running |

---

## 4. Edge Cases

- **Empty queue** — `BLPOP` with a timeout returns nil. Worker loops and
  checks again. Clean, no busy-wait.
- **Depth > MAX_DEPTH** — URL is dropped before `crawl()` is called. Not
  an error, just filtered.
- **Pages > MAX_PAGES** — worker breaks the loop, marks job done.
- **`crawl()` throws** — catch the error, log it, continue to next URL.
  One bad page shouldn't kill the whole crawl.
- **Same URL discovered multiple times** — without dedup (feature 3), we'll
  re-crawl it. Acceptable for now — the `upsert` in `crawl()` makes it
  idempotent. The queue just does extra work.
- **Process restart** — Redis LIST is lost. Crawl stops. Acceptable for now.
- **Queue grows faster than worker drains it** — with one worker and no
  dedup, a site with many links can balloon the queue fast. MAX_PAGES is
  the backstop.

---

## 5. Trade-offs

| Decision | Chose | Gave up | Why |
|---|---|---|---|
| Queue backend | Redis LIST | Postgres SKIP LOCKED | faster, canonical, already running |
| Queue library | raw ioredis | BullMQ | learn the primitive, not the abstraction |
| Traversal | BFS (FIFO) | DFS, priority | matches the book, explores site breadth-first |
| Depth tracking | JSON payload in queue | separate Redis hash | self-contained, no extra lookups |
| Worker location | in-process async loop | separate process | simplest for now; feature 5 promotes it |
| Dedup | none yet | efficiency | deliberate — feature 3 wraps the frontier |

---

## 6. Definition of Done

- `POST /api/crawl/job { url: "https://www.nyu.edu" }` → `202` with jobId.
- Worker runs in background, crawling discovered links automatically.
- `GET /api/crawl/job/:jobId` → shows pages crawled count climbing.
- After crawl completes, Postgres has multiple Page rows + their Link rows.
- Depth limiting works: pages at depth > MAX_DEPTH are not crawled.
- MAX_PAGES cap works: worker stops after N pages regardless of queue size.
- One bad URL (404, timeout) doesn't stop the crawl.
