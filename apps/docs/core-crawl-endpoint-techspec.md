# Core Crawl Endpoint — Tech Spec

> **Feature 1 of the crawler.** The atomic unit: take one URL, fetch it, parse it,
> persist the page and its outbound links. Everything later — frontier, dedup,
> politeness, jobs — just *orchestrates repeated calls to this one operation*.
>
> **Maps to** Alex Yu, *System Design Interview Vol. 1*, Ch. 9. The crawler there is an
> 11-step BFS loop: `Seed URLs → URL Frontier → HTML Downloader (+DNS) → Content Parser
> → "Content Seen?" → URL Extractor → URL Filter → "URL Seen?" → URL Frontier`.
> **This feature is the three middle boxes — HTML Downloader + Content Parser + URL
> Extractor — with the Frontier and both dedup checks stubbed out.** We build the
> stable core first, then wrap it.

---

## 1. Problem

Given a seed URL, fetch its HTML, pull out the page title and every outbound `<a href>`
link, and persist both the page and the discovered links. Expose this through one REST
endpoint so we can drive it with curl/Postman now and RTK Query later.

**Deliberately out of scope** (to stay one-feature-at-a-time):

- Following the links it finds → **URL Frontier (feature 2)**.
- "Have we seen this URL / this content before?" → **dedup (feature 3)**.
- Per-host rate limiting / robots.txt → **politeness (feature 4)**.
- Background execution — the crawl runs **synchronously inside the request**. That's a
  deliberate stepping stone; **feature 5 (jobs)** makes it async.

If you find yourself wanting any of the above while building this, stop — that's a signal
you're bleeding into the next feature. Note it and move on.

---

## 2. Approach

`POST /api/crawl { url }` → validate → fetch → parse → normalize links → persist → return.

Pipeline:

1. **Validate** with zod. Must be a well-formed `http`/`https` URL. Reject anything else
   early → `400`.
2. **Fetch** with undici (Node's built-in `fetch`): `AbortController` timeout, explicit
   `User-Agent`, follow redirects (capped), read body with a size cap.
3. **Guard** on the response: non-2xx, or content-type that isn't `text/html` → persist a
   minimal Page (status + contentType) and return with zero links. We do **not** run an
   HTML parser on a PDF/image/JSON body.
4. **Parse** with cheerio: `<title>` + every `a[href]`.
5. **Normalize links**: resolve relative → absolute against the **final** URL (post-redirect),
   strip fragments, keep only http/https, dedupe within the page.
6. **Persist** in one Prisma transaction: upsert the Page by URL, replace its Links.
7. **Respond** `201` with page + links.

### Why these specific choices

- **cheerio, not a headless browser.** cheerio is a fast server-side HTML parser with *no
  JS execution*. The book's HTML Downloader is a static fetch, so this matches the
  reference design exactly. Trade-off: pages that build their links via client-side JS
  (SPAs) yield few/no links. We accept that now. If it bites later, feature-flag a
  Playwright fallback — but don't reach for a headless browser by default, it's roughly
  10x the CPU/RAM per page and turns a stateless fetch into a managed process.
- **Synchronous crawl inside the request.** The simplest thing that lets you see an
  end-to-end result. It does **not** scale — a slow target blocks the request, there's no
  concurrency control, and a long crawl would time out the HTTP client. That's fine: the
  queue/worker (feature 2) and the jobs model (feature 5) exist precisely to fix this.
  Naming the limitation so it's a *decision*, not an accident you discover in prod.
- **undici `fetch` over axios.** Built into Node 18+, zero dependency, native
  `AbortController` and redirect control. axios buys you nothing here.

---

## 3. Schema / API Contracts

### Prisma models

```prisma
model Page {
  id          String   @id @default(cuid())
  url         String   @unique           // the URL we were asked to crawl
  finalUrl    String                      // after redirects (may equal url)
  statusCode  Int
  contentType String?
  title       String?
  html        String?  @db.Text           // raw body; feeds content-hash dedup later
  contentHash String?                      // null now; populated in feature 3
  fetchedAt   DateTime @default(now())
  links       Link[]

  @@index([fetchedAt])
}

model Link {
  id         String   @id @default(cuid())
  fromPageId String
  fromPage   Page     @relation(fields: [fromPageId], references: [id], onDelete: Cascade)
  toUrl      String                        // discovered outbound URL (not yet a Page)
  createdAt  DateTime @default(now())

  @@unique([fromPageId, toUrl])            // no duplicate edge from the same page
  @@index([toUrl])                         // feature 2 queries this to seed the frontier
}
```

**Why a `Link` table instead of a `links String[]` column on `Page`:**

The array column ships faster, but you can't index or query edges with it. The frontier
(feature 2) needs to answer *"what URLs have we discovered that we haven't crawled yet?"* —
that's a query over `Link.toUrl` anti-joined against `Page.url`. With an array column that's
awkward and unindexed; with a normalized edge table it's a one-liner, and it models the
crawl as the **directed graph** the book describes (pages = nodes, links = edges). Cost
accepted: one extra table and a transaction on write. Worth it.

**Why store `html` now** even though we don't use it yet: feature 3's "Content Seen?" needs
a content hash, and you can't hash what you didn't keep. `@db.Text` because page bodies blow
past the default `varchar` limit. If storage hurts before feature 3, we switch to hashing
on the fly and dropping the body — but keeping it is the cheaper bet for a learning corpus.

### HTTP contract

```
POST /api/crawl
Content-Type: application/json

Request:
  { "url": "https://example.com" }

201 Created:
  {
    "page": {
      "id": "clx...",
      "url": "https://example.com",
      "finalUrl": "https://example.com/",
      "statusCode": 200,
      "contentType": "text/html; charset=utf-8",
      "title": "Example Domain",
      "fetchedAt": "2026-06-23T14:02:11.000Z"
    },
    "links": ["https://www.iana.org/domains/example"],
    "linkCount": 1
  }
```

Error envelope (keep this shape consistent across the whole API):

```json
{ "error": { "code": "invalid_url", "message": "url must be a valid http(s) URL" } }
```

| Status | code             | When                                                  |
|--------|------------------|-------------------------------------------------------|
| 400    | `invalid_url`    | body failed zod validation                            |
| 422    | `fetch_failed`   | upstream returned non-2xx, or body wasn't HTML        |
| 504    | `fetch_timeout`  | upstream exceeded the fetch timeout                   |
| 502    | `fetch_error`    | DNS failure / connection refused / request aborted    |

---

## 4. Edge Cases

- **Relative links** (`/about`) → `new URL(href, finalUrl)`.
- **Protocol-relative** (`//cdn.x.com/a`) → `new URL` inherits the scheme from the base.
- **Fragments** (`/p#section`) → strip the hash; a bare `#section` → drop (same page).
- **Non-navigational hrefs** (`mailto:`, `tel:`, `javascript:`) → filter out, keep http/https only.
- **Duplicate links on one page** → dedupe with a `Set` before insert; `@@unique` is the backstop.
- **Redirects** → follow, cap at ~5, record `finalUrl`. A redirect loop → undici throws → `502`.
- **Non-HTML body** (PDF/image/JSON) → record status + contentType, store zero links, `201`. Never feed it to cheerio.
- **Huge pages** → cap the body read (e.g. 5 MB) so one giant page can't OOM the worker.
- **Timeouts** → `AbortController` (~10s) → `504`.
- **Re-crawling the same URL** → upsert the Page, delete+recreate its Links (idempotent). True "skip if already seen" is feature 3.
- **SSRF — read this one.** The URL is attacker-controllable. Left open,
  `{"url":"http://169.254.169.254/latest/meta-data/"}` reads your cloud metadata, and
  `{"url":"http://localhost:5432"}` lets a caller port-scan your internal network through
  your server. Minimum bar for the learning build: resolve the host and **reject loopback /
  private / link-local ranges before fetching**. Flagging it now because it's invisible
  until someone points it out — and *every* "fetch a user-supplied URL" feature you ever
  build has this exact hole. Train the reflex here.

---

## 5. Trade-offs (summary)

| Decision      | Chose                  | Gave up                  | Why                                                                 |
|---------------|------------------------|--------------------------|---------------------------------------------------------------------|
| Parser        | cheerio (static)       | JS-rendered links        | ~10x cheaper; matches the book's static HTML Downloader             |
| Execution     | sync, in-request       | throughput, concurrency  | simplest end-to-end slice; queue + jobs fix it in features 2 & 5    |
| Link storage  | normalized `Link` table| a little more write work | queryable crawl graph; cleanly seeds the frontier                   |
| Store HTML    | yes (`@db.Text`)       | row size                 | needed for content-hash dedup (feature 3); revisit if storage hurts |
| HTTP client   | undici `fetch`         | axios conveniences       | zero-dep, native `AbortController` + redirect control               |

---

## 6. Definition of Done

- `POST /api/crawl` against a real public page → `201` with a non-empty `links` array.
- Page + Link rows visible in Postgres (Prisma Studio).
- Re-running the **same** URL does not duplicate Links (idempotent).
- Invalid URL → `400`; a 404 target → `422`; a deliberately slow target → `504`.
- *(Stretch)* a private-IP URL is rejected **before** any fetch leaves the box.
