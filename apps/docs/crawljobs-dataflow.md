# Crawl Jobs — Data Flow

> Feature 5 adds Postgres persistence around the existing worker loop.
> The crawl logic itself is unchanged. Job state now survives Redis cleanup.

---

## What changes vs feature 4

```
Feature 4 worker:                   Feature 5 worker:
  startJob()                          startJob()
    RPUSH seed                          CREATE CrawlJob (status=RUNNING)  ← NEW
    SET count 0                         RPUSH seed
    runWorker()                         SET count 0
    return { jobId }                    runWorker()
                                        return { jobId }

  loop:                               loop:
    BLPOP                               GET stop:<jobId>  ← NEW
    depth check                         if stop → break
    seen check                          BLPOP
    robots check                        depth/seen/robots checks
    cooldown check                      cooldown check
    crawl(url)                          crawl(url)
    SADD seen                           SADD seen
    INCR count                          INCR count
    RPUSH links                         if count % 10 == 0:              ← NEW
                                          UPDATE CrawlJob pagesCrawled
                                        RPUSH links

  cleanup:                            cleanup:
    DEL frontier                        DEL frontier, count, seen, stop
    DEL count                           UPDATE CrawlJob status=COMPLETED  ← NEW
    DEL seen                            UPDATE CrawlJob completedAt=now()
```

---

## POST /api/crawl/job — updated lifecycle

```
Client
  │  POST /api/crawl/job { url, maxDepth, maxPages, crawlDelay }
  ▼
Controller → startJob()
  │
  ├─ CREATE CrawlJob in Postgres
  │    { id: jobId, seedUrl, status: RUNNING, maxDepth, maxPages, crawlDelay }
  │
  ├─ RPUSH frontier:<jobId> seed url
  ├─ SET frontier:<jobId>:count 0
  │
  ├─ runWorker() ← non-blocking, background
  │
  └─ 202 { jobId, status: "running", seedUrl }
```

---

## Worker loop — stop signal check

```
top of each iteration:

GET stop:<jobId>
  │
  ├─ exists ("1") ──▶ break loop
  │                   UPDATE CrawlJob status=STOPPED, completedAt=now()
  │                   DEL all redis keys
  │
  └─ missing ──▶ continue normal loop
```

---

## GET /api/crawl/job/:jobId — updated

```
Client
  │  GET /api/crawl/job/clx123
  ▼
Controller → getJobStatus(jobId)
  │
  ├─ SELECT * FROM CrawlJob WHERE id = jobId
  │    │
  │    ├─ not found ──▶ 404
  │    │
  │    └─ found
  │         │
  │         ├─ status = RUNNING
  │         │    │
  │         │    ├─ GET frontier:<jobId>:count  (live counter from Redis)
  │         │    ├─ LLEN frontier:<jobId>       (live queue size from Redis)
  │         │    └─ return { ...job, pagesCrawled: redisCount, queueSize }
  │         │
  │         └─ status = COMPLETED | FAILED | STOPPED
  │              │
  │              └─ return { ...job } (all data from Postgres, no Redis needed)
  │
  └─ 200 { jobId, status, seedUrl, pagesCrawled, queueSize?, startedAt, completedAt? }
```

---

## DELETE /api/crawl/job/:jobId

```
Client
  │  DELETE /api/crawl/job/clx123
  ▼
Controller
  │
  ├─ SELECT * FROM CrawlJob WHERE id = jobId
  │    ├─ not found ──▶ 404
  │    └─ status != RUNNING ──▶ 400 not_running
  │
  ├─ SET stop:<jobId> 1 EX 3600
  │
  └─ 202 { jobId, message: "stop signal sent" }

  [worker picks up stop signal on next iteration]
  [updates CrawlJob status=STOPPED in Postgres]
```

---

## What's in each store at each lifecycle stage

```
Stage: job created
  Postgres: CrawlJob { status: RUNNING, pagesCrawled: 0 }
  Redis:    frontier:<jobId> = [seed], count = "0"

Stage: job running (mid-crawl)
  Postgres: CrawlJob { status: RUNNING, pagesCrawled: 40 } (synced every 10)
  Redis:    frontier:<jobId> = [200 urls], count = "47" (live)

Stage: stop signal sent
  Postgres: CrawlJob { status: RUNNING, pagesCrawled: 40 }
  Redis:    frontier:<jobId> = [...], count = "47", stop:<jobId> = "1"

Stage: job stopped
  Postgres: CrawlJob { status: STOPPED, pagesCrawled: 47, completedAt: ... }
  Redis:    (all keys deleted)

Stage: job completed naturally
  Postgres: CrawlJob { status: COMPLETED, pagesCrawled: 100, completedAt: ... }
  Redis:    (all keys deleted)
```

---

## GET /api/crawl/jobs — list

```
Client
  │  GET /api/crawl/jobs
  ▼
Controller
  │
  SELECT * FROM CrawlJob ORDER BY startedAt DESC LIMIT 20
  │
  └─ 200 { jobs: [...] }
```

Simple Postgres query. No Redis needed. Returns history of all jobs.
