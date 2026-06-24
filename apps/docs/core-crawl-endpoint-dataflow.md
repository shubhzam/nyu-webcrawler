# Core Crawl Endpoint — Data Flow

> How a single crawl request moves through the system. Feature 1 has **no cache and no
> queue yet** — this doc shows the MVP path and marks exactly where Redis and the URL
> Frontier splice in later, so you can see the seams *before* we build them.

---

## Components in play (feature 1)

- **Client** — curl/Postman now; Next.js + RTK Query later.
- **Express API** (`apps/api`) — router → controller → service.
- **Crawl service** — fetch + parse + normalize (the book's HTML Downloader + Content Parser + URL Extractor).
- **Target website** — the external page being crawled.
- **Prisma + Postgres** — persistence (`Page`, `Link`).
- **Redis** — **not used yet.** Annotated below where it lands.

---

## Request / Response lifecycle

1. Client sends `POST /api/crawl { url }`.
2. Express matches the route; controller reads `url` from the body.
3. **zod** validates → invalid → `400 invalid_url` *(request ends)*.
4. Controller calls `crawlService.crawl(url)`.
5. Service **fetches** the target (undici; `User-Agent`, `AbortController(10s)`, capped redirects).
   - timeout → `504`; DNS / connection error → `502` *(request ends)*.
6. Service inspects the response:
   - non-2xx **or** non-`text/html` → persist a minimal Page, return early with empty links.
7. Service reads the body (size-capped) and **parses** with cheerio → title + `a[href]`.
8. Service **normalizes** links: absolute against `finalUrl`, strip fragments, http/https only, dedupe.
9. Service **persists** in one Prisma transaction:
   - `upsert` Page by `url`.
   - `deleteMany` old Links for the page, then `createMany` the new set.
10. Service returns `{ page, links }`; controller responds `201`.

---

## Sequence — MVP (feature 1)

```
 Client
   │  POST /api/crawl { url }
   ▼
 Express Router ──▶ Controller
                      │ zod validate ──✗──▶ 400 invalid_url
                      │ ✓
                      ▼
                 CrawlService.crawl(url)
                      │ 1. undici fetch ──(timeout)──▶ 504
                      │                  ──(net err)──▶ 502
                      ▼
                External Website
                      │  HTML (or non-HTML)
                      ▼
                 CrawlService
                      │ 2. content-type guard
                      │ 3. cheerio parse (title, a[href])
                      │ 4. normalize + filter + dedupe links
                      ▼
                 Prisma ── transaction ──▶ Postgres
                      │   upsert Page
                      │   replace Links
                      ▼
                 { page, links }
                      │
                      ▼
 Client ◀── 201 { page, links, linkCount }
```

---

## Where the cache and queue splice in later (do NOT build now)

```
                        (feature 3)                     (feature 4)
 Client          ┌────"URL seen?"────┐          ┌──per-host rate limit──┐
   │             │ Redis SET of      │          │ Redis: next-allowed   │
   │             │ crawled URLs —    │          │ timestamp per host    │
   │             │ skip if hit       │          │                       │
   ▼             ▼                   │          ▼                       │
 Controller ─▶ Frontier (feature 2) ─┴─▶ CrawlService.crawl(url) ─▶ ... ─▶ Postgres
   ▲             │ Redis LIST/queue  │
   │             │ of pending URLs   │
   │             │ (BFS); worker     │
   └─────────────┘ pulls + calls ────┘
                   this SAME crawl()
                                     │
                                     ▼
                         (feature 3) "Content seen?"
                         hash(html) in Redis/DB — skip store if dup
```

**Reading the seams:**

- **Feature 2 (URL Frontier):** instead of the client calling `crawl()` once, a worker
  pulls URLs from a Redis FIFO queue (the book's BFS frontier) and calls *the same*
  `crawl()`. The `Link.toUrl` rows we write today are exactly what seed that queue.
- **Feature 3 (dedup):** a Redis SET answers *"URL Seen?"* before we fetch; a content hash
  answers *"Content Seen?"* before we store. Both **wrap** the existing `crawl()` — they
  don't change its internals.
- **Feature 4 (politeness):** a per-host check in Redis gates *when* `crawl()` may run for
  a given domain (the book's "download one page at a time per host, with a delay").

**The point:** the synchronous `crawl(url)` you build now is the stable core. Every later
feature **wraps or schedules** it rather than rewriting it. So get this one clean — its seams
are the whole rest of the project.
