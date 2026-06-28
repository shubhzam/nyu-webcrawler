# Deduplication — Data Flow

> Feature 3 adds two guards to the worker loop. Nothing else changes.
> `crawl()` gets one internal change (content hashing). The API is untouched.

---

## Where the two checks live in the pipeline

```
Worker loop (feature 2):            Worker loop (feature 3):
  BLPOP url                           BLPOP url
  if depth > max → skip               if depth > max → skip
  crawl(url)                          SISMEMBER seen-urls url    ← URL Seen?
  INCR count                          if seen → continue (skip)
  RPUSH links                         crawl(url)                 ← content hash checked inside
                                      SADD seen-urls finalUrl    ← mark seen
                                      INCR count
                                      RPUSH links
```

---

## URL Seen? — full flow

```
Worker
  │
  │  url = "https://www.nyu.edu/"
  ▼
SISMEMBER seen-urls:<jobId> "https://www.nyu.edu/"
  │
  ├─ 1 (seen) ──▶ continue   [skip — don't crawl, don't enqueue children]
  │
  └─ 0 (not seen)
       │
       ▼
    crawl(url)
       │
       ▼
    SADD seen-urls:<jobId> finalUrl   [mark the POST-REDIRECT url as seen]
       │
       ▼
    INCR count, RPUSH links
```

**Why we store `finalUrl` not `url`:**

```
input url:   "https://www.nyu.edu"    (no trailing slash)
after fetch: response.url = "https://www.nyu.edu/"  (redirect)
finalUrl:    "https://www.nyu.edu/"

SADD seen-urls "https://www.nyu.edu/"   ← store finalUrl

later, another link discovers "https://www.nyu.edu/"
SISMEMBER seen-urls "https://www.nyu.edu/" → 1 (seen) → skip ✓

if we stored the input url instead:
SADD seen-urls "https://www.nyu.edu"    ← store input
later link: "https://www.nyu.edu/"
SISMEMBER seen-urls "https://www.nyu.edu/" → 0 (not seen) → re-crawl ✗
```

---

## Content Seen? — full flow

```
crawl(url)
  │
  │  fetch HTML
  │  html = "<!DOCTYPE html><html>..."
  │
  ▼
contentHash = md5(html)   [32-char hex string]
  │
  ▼
SELECT * FROM Page WHERE contentHash = contentHash
  │
  ├─ found ──▶ return { page: existingPage, links, linkCount }
  │            [skip Postgres upsert — content already stored]
  │            [still return links so worker can enqueue them]
  │
  └─ not found
       │
       ▼
    prisma.$transaction
      upsert Page (with contentHash populated)
      deleteMany + createMany Links
       │
       ▼
    return { page, links, linkCount }
```

**The key behaviour difference:**

```
URL Seen?      → skip everything (no crawl, no links enqueued)
Content Seen?  → skip storage only (links still enqueued)
```

URL Seen skips everything because we've already processed this URL —
we have its links in the DB. Content Seen only skips the store because
even though the content is duplicate, the URL is new and may have links
we haven't seen yet.

---

## Concrete example — nyu.edu/academics discovered twice

```
Iteration 12:
  BLPOP → { url: "https://www.nyu.edu/academics.html", depth: 1 }
  SISMEMBER seen-urls → 0 (not seen)
  crawl("https://www.nyu.edu/academics.html")
    → fetch → html → md5 → "a3f8c2..."
    → SELECT contentHash = "a3f8c2..." → null (not found)
    → upsert Page, createMany Links
  SADD seen-urls "https://www.nyu.edu/academics.html"
  RPUSH 30 child links

Iteration 47:
  BLPOP → { url: "https://www.nyu.edu/academics.html", depth: 2 }
  SISMEMBER seen-urls → 1 (seen!)
  continue   ← skipped entirely, no fetch, no DB write
```

---

## Redis keys after feature 3

```
frontier:<jobId>          LIST   BFS queue (unchanged)
frontier:<jobId>:count    STRING pages crawled counter (unchanged)
seen-urls:<jobId>         SET    all finalUrls crawled this job  ← NEW
```

All three deleted when the job completes.

---

## What changes vs feature 2

| File | Change |
|---|---|
| `frontier.service.ts` | add `SISMEMBER` before crawl, `SADD` after |
| `crawl.service.ts` | compute `md5(html)`, check+populate `contentHash` |
| `prisma/schema.prisma` | add `@@index([contentHash])` |
| Everything else | unchanged |
