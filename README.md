# Web Crawler

A self-hostable web crawler that collects webpage content (HTML, titles, links) from any site you point it at. Give it a seed URL and it walks outward, storing what it finds.

I built this to gather and structure webpage content for **RAG applications** — part of my on-campus SDE role at NYU. It's intentionally **general purpose**, so it works as a content-collection layer for any AI application: no dependency on paid crawl/search APIs like Tavily, Firecrawl, etc. You run it yourself, you own the data.

## How it works

```
seed URL ──▶ API ──▶ Redis frontier (queue) ──▶ worker ──▶ Postgres (pages + links)
                          ▲                          │
                          └──── newly found links ───┘
```

1. **Submit a job** — you give the API a seed URL plus a few limits (max depth, max pages, crawl delay). It creates a job record and drops the seed into a queue.

2. **The frontier** — URLs to visit live in a Redis-backed queue. A background worker pulls one URL at a time and keeps going until the queue empties or a limit is hit.

3. **Crawl a page** — for each URL the worker fetches the page, extracts the title and all links with Cheerio, and saves the page + its outgoing links to Postgres. Every link it discovers gets pushed back onto the queue (one level deeper), so the crawl fans out automatically.

4. **Being a good citizen** — before fetching anything the worker checks the site's `robots.txt` and respects a per-host rate limit (cooldown) so it doesn't hammer a single domain.

5. **No duplicate work** — already-seen URLs are skipped, and pages with identical content (matched by a content hash) aren't stored twice.

6. **Track it** — job progress (pages crawled, queue size, status) is queryable while it runs, and you can stop a job mid-flight. Finished jobs are persisted in Postgres. A small Next.js frontend lets you start jobs and watch them live.

## Stack

- **API** — Express + TypeScript
- **Queue / dedup / rate limiting** — Redis
- **Storage** — Postgres via Prisma
- **Frontend** — Next.js + Redux Toolkit Query
- **Monorepo** — Turborepo + pnpm

## Running it

Start Postgres and Redis:

```sh
docker compose up -d
```

Then install and run everything in dev:

```sh
pnpm install
pnpm dev
```

The API comes up on `:3000` and the web UI on `:3001`.

## API at a glance

| Method | Route | What it does |
| --- | --- | --- |
| `POST` | `/api/crawl` | Crawl a single URL (no queue) |
| `POST` | `/api/crawl/job` | Start a crawl job from a seed URL |
| `GET` | `/api/crawl/job/:jobId` | Get live job status |
| `DELETE` | `/api/crawl/job/:jobId` | Stop a running job |
| `GET` | `/api/crawl/jobs` | List recent jobs |
