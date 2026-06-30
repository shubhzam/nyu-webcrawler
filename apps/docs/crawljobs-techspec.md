# Crawl Jobs — Tech Spec

> **Feature 5 of the crawler.** The book states: *"Save crawl states and
> data: To guard against failures, crawl states and data are written to a
> storage system. A disrupted crawl can be restarted easily by loading
> saved states and data."*
>
> Right now job state lives only in Redis and is deleted when the job
> completes. `GET /api/crawl/job/:jobId` returns `not_found` immediately
> after completion. Feature 5 persists job records to Postgres so job
> history survives forever, and adds start/stop controls.

---

## 1. Problem

Three gaps in the current system:

**No job history.** Once a job completes and Redis keys are deleted, all
metadata (when it ran, how many pages, what seed URL, did it succeed) is
gone. You can't audit past crawls.

**No status after completion.** `GET /job/:id` returns `not_found` the
moment a job finishes. The client has no way to know if the job completed
successfully or just disappeared.

**No stop control.** Once started, a job runs until `maxPages` or queue
empty. There's no way to cancel a running job mid-crawl.

---

## 2. Approach

### New `CrawlJob` Prisma model

Persist job state to Postgres. The model tracks the full lifecycle:

```
created → running → completed | failed | stopped
```

Written at three points:
1. `startJob()` — create the record with status `running`
2. Worker loop — update `pagesCrawled` periodically (every 10 pages)
3. Worker completion — update status to `completed`, `failed`, or `stopped`

### Stop mechanism — Redis flag

To stop a running job, set a Redis key:

```
SET stop:<jobId> 1
```

The worker loop checks this flag at the top of each iteration. If it
exists, the worker breaks cleanly and updates the job status to `stopped`.

**Why Redis not Postgres for the stop flag?**
The worker loop reads this on every iteration. A Postgres query on every
loop tick would add latency and DB load. Redis GET is O(1) in memory —
the right tool for a hot-path check.

### Updated `GET /job/:jobId`

Now reads from Postgres first, falls back to Redis for live `queueSize`:

```
1. SELECT * FROM CrawlJob WHERE id = jobId
2. if not found → 404
3. if status = running → also GET queueSize from Redis
4. return combined response
```

### New `DELETE /api/crawl/job/:jobId`

Stops a running job:

```
1. find job in Postgres
2. if not running → 400 (nothing to stop)
3. SET stop:<jobId> 1 EX 3600
4. return 202 (stop signal sent, worker will stop shortly)
```

---

## 3. Schema

### New Prisma model

```prisma
model CrawlJob {
  id           String    @id @default(cuid())
  seedUrl      String
  status       JobStatus @default(RUNNING)
  maxDepth     Int
  maxPages     Int
  crawlDelay   Int
  pagesCrawled Int       @default(0)
  startedAt    DateTime  @default(now())
  completedAt  DateTime?
  error        String?

  @@index([status])
  @@index([startedAt])
}

enum JobStatus {
  RUNNING
  COMPLETED
  FAILED
  STOPPED
}
```

### New Redis key

```
stop:<jobId>    STRING "1", EX 3600  (exists = stop signal sent)
```

---

## 4. API Contracts

### POST /api/crawl/job (updated response)

```json
202 Accepted:
{
  "jobId": "clx...",
  "status": "running",
  "seedUrl": "https://www.nyu.edu"
}
```

### GET /api/crawl/job/:jobId (updated)

```json
200 OK (running):
{
  "jobId": "clx...",
  "status": "running",
  "seedUrl": "https://www.nyu.edu",
  "pagesCrawled": 47,
  "queueSize": 312,
  "startedAt": "2026-06-24T19:25:01.132Z"
}

200 OK (completed):
{
  "jobId": "clx...",
  "status": "completed",
  "seedUrl": "https://www.nyu.edu",
  "pagesCrawled": 100,
  "queueSize": 0,
  "startedAt": "2026-06-24T19:25:01.132Z",
  "completedAt": "2026-06-24T19:27:43.000Z"
}
```

### DELETE /api/crawl/job/:jobId (new)

```
202 Accepted:
{ "jobId": "clx...", "message": "stop signal sent" }

400 Bad Request:
{ "error": { "code": "not_running", "message": "job is not running" } }

404 Not Found:
{ "error": { "code": "not_found", "message": "job not found" } }
```

### GET /api/crawl/jobs (new — list all jobs)

```json
200 OK:
{
  "jobs": [
    {
      "jobId": "clx...",
      "seedUrl": "https://www.nyu.edu",
      "status": "completed",
      "pagesCrawled": 100,
      "startedAt": "...",
      "completedAt": "..."
    }
  ]
}
```

---

## 5. Edge Cases

- **Worker crashes mid-crawl** — job stays as `running` in Postgres forever.
  Fix: a cleanup job (cron) that marks jobs older than N hours as `failed`.
  Out of scope for now, flagged.
- **Stop signal arrives after job completes** — Redis key exists but job
  is already `completed`. Worker already exited. Key expires in 1h. No harm.
- **Double stop** — two `DELETE` requests for the same job. Second one
  finds job already `stopped`. Returns 400 `not_running`.
- **pagesCrawled sync** — Redis counter and Postgres `pagesCrawled` can
  drift (we only sync every 10 pages). On completion we do a final sync.
  During a running job, `GET /job/:id` returns the Redis counter (more
  accurate) not the Postgres value.

---

## 6. Definition of Done

- `GET /api/crawl/job/:jobId` returns full job data after completion.
- `GET /api/crawl/jobs` lists all past jobs.
- `DELETE /api/crawl/job/:jobId` stops a running job within ~1 iteration.
- `CrawlJob` rows in Prisma Studio after every job.
- Job status transitions correctly: `running` → `completed` / `stopped` / `failed`.
