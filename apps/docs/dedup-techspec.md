# Deduplication — Tech Spec

> **Feature 3 of the crawler.** The book states: *"Online research reveals that
> 29% of web pages are duplicated contents, which may cause the same content
> to be stored multiple times."* Dedup fixes two distinct problems: crawling
> the same URL twice, and storing the same content under different URLs.
>
> **Maps to** Alex Yu Ch. 9, steps 5-6 ("Content Seen?") and steps 9-11
> ("URL Seen?") of the crawler workflow.

---

## 1. Problem

After feature 2 we saw two bugs in the logs:

```
crawling depth=0 url=https://www.nyu.edu
crawling depth=1 url=https://www.nyu.edu/     ← same page, different URL
```

`nyu.edu` redirects to `nyu.edu/`. Both get crawled, both get stored, both
get their links enqueued — doubling the work. At scale, without dedup a
crawler re-crawls the entire web on every pass.

Two separate checks are needed because they catch different problems:

**"URL Seen?"** — have we already crawled this URL? Prevents redundant fetches.
Catches: `nyu.edu` vs `nyu.edu/`, the same URL discovered via multiple paths.

**"Content Seen?"** — have we already seen this HTML content? Prevents
duplicate storage. Catches: mirror pages (`nyu.edu/page` and `nyu.edu/page?ref=nav`
serving identical HTML), A/B test variants, printer-friendly versions.

---

## 2. Approach

### URL Seen? — Redis SET

Before calling `crawl(url)`, check a Redis SET of already-crawled URLs.

```
SISMEMBER seen-urls:<jobId> <url>
→ 1 (already seen) → skip, don't crawl
→ 0 (not seen)     → crawl, then SADD seen-urls:<jobId> <url>
```

**Why Redis SET over Postgres query?**
A `SELECT` against the `Page` table would work but costs a round-trip to
Postgres on every URL check. Redis SET membership check (`SISMEMBER`) is
O(1) in memory — orders of magnitude faster. At 10,000 URLs/min, the
difference is real. Also keeps the "working state" (seen URLs for this job)
separate from the "permanent state" (crawled pages).

**What URL do we store?** The `finalUrl` (post-redirect), not the input URL.
`nyu.edu` redirects to `nyu.edu/` — we store `nyu.edu/` so that if `nyu.edu/`
is discovered later via another link, it's correctly identified as seen.

**Bloom filter vs hash table:** The book mentions bloom filters as a
space-efficient alternative. A bloom filter can have false positives (says
"seen" when it hasn't), but never false negatives. For a learning project
a Redis SET is simpler and has zero false positives. We use Redis SET.

### Content Seen? — hash stored in Postgres

After fetching HTML, hash it and check against previously stored hashes.

```
hash = md5(html)
existing = SELECT id FROM Page WHERE contentHash = hash
→ found    → skip storing, still extract and enqueue links
→ not found → store page, save hash
```

**Why MD5?** Fast, produces a short fixed-length string (32 chars), and
collision probability is negligible for web pages. We're not using this
for security — just equality detection. The book says *"compare hash values
of the two web pages"* — MD5 is the standard choice.

**Why Postgres not Redis?** Content hashes are permanent — they should
survive process restarts. URL seen state is job-scoped and ephemeral.
Also, `contentHash` is already a nullable column on the `Page` model from
feature 1 — we just start populating it.

**Important:** content-seen doesn't skip link extraction. Even if we've seen
the content before, we still extract links and enqueue them — the page might
link to pages we haven't seen. We only skip the Postgres upsert.

### Where these checks live

Both checks go in the **worker loop** in `frontier.service.ts`. The
`crawl()` function stays unchanged — dedup is the frontier's responsibility,
not the crawler's.

```typescript
// worker loop (updated)
const item = await redis.blpop(frontierKey(jobId), 5)
const { url, depth } = JSON.parse(item[1])

// URL Seen? check  ← NEW
const seen = await redis.sismember(seenKey(jobId), url)
if (seen) continue

// crawl as before
const { links, page } = await crawl(url)

// mark URL as seen  ← NEW
await redis.sadd(seenKey(jobId), page.finalUrl)

// Content Seen? is handled inside crawl() ← NEW (next section)

await redis.incr(countKey(jobId))
// enqueue links...
```

### Schema change — populate `contentHash`

`contentHash` is already on the `Page` model (we planned for this in feature
1). We now populate it in `crawl.service.ts`:

```typescript
import { createHash } from 'crypto'

const contentHash = createHash('md5').update(html).digest('hex')

// check before storing
const existing = await prisma.page.findFirst({ where: { contentHash } })
if (existing) {
  // content already stored - return links but skip upsert
  return { page: existing, links, linkCount: links.length }
}

// store with hash
await tx.page.upsert({
  ...
  create: { ..., contentHash },
  update: { ..., contentHash },
})
```

---

## 3. Schema / API Contracts

### No new Prisma models

`contentHash` is already on `Page`. We add one index for the content-seen
lookup:

```prisma
model Page {
  ...
  contentHash String?
  ...
  @@index([contentHash])  ← ADD THIS
}
```

Without the index, `WHERE contentHash = hash` is a full table scan. With
it, O(log n).

### New Redis key

```
seen-urls:<jobId>    SET of crawled finalUrls (deleted when job completes)
```

### No API changes

Both checks are internal to the worker loop. The `POST /api/crawl/job` and
`GET /api/crawl/job/:jobId` contracts are unchanged.

---

## 4. Edge Cases

- **Trailing slash:** `nyu.edu` → redirects to → `nyu.edu/`. We store
  `finalUrl` in the SET, so `nyu.edu/` is what gets marked seen. If
  `nyu.edu/` is later discovered as a link, `SISMEMBER` correctly returns 1.
- **Query strings:** `nyu.edu/search?q=ai` and `nyu.edu/search?q=ml` have
  the same path but different content. URL-seen treats them as different
  (different strings). Content-seen catches them if they happen to return
  the same HTML.
- **Hash collision (MD5):** ~1 in 2^128 chance. Astronomically unlikely for
  a learning project. If it happens, a page gets skipped that shouldn't.
  Acceptable.
- **Cross-job dedup:** `seen-urls:<jobId>` is scoped per job. Two jobs
  crawling the same site don't share seen state. Intentional — each job
  is an independent crawl.
- **seen-urls SET cleanup:** deleted alongside the frontier keys when the
  job completes.

---

## 5. Trade-offs

| Decision | Chose | Gave up | Why |
|---|---|---|---|
| URL Seen store | Redis SET | Bloom filter | simpler, zero false positives |
| URL Seen scope | per-job | global across jobs | simpler, jobs are independent |
| Content Seen store | Postgres (contentHash column) | Redis | permanent, survives restarts |
| Hash algorithm | MD5 | SHA-256 | faster, shorter, collision risk negligible |
| Content-seen behaviour | skip store, still extract links | skip everything | links might be new even if content isn't |

---

## 6. Definition of Done

- Re-running `POST /api/crawl/job` on `nyu.edu` — no URL crawled twice
  within the same job.
- `nyu.edu` and `nyu.edu/` counted as one page (finalUrl dedup).
- `Page.contentHash` populated on every stored page.
- Duplicate content (same HTML, different URL) → only one Page row stored.
- `seen-urls:<jobId>` SET deleted when job completes.
- Crawl log shows "skipping seen url" messages for duplicates.
