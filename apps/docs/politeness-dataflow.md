# Politeness — Data Flow

> Feature 4 adds two guards to the worker loop. `crawl()` is unchanged.
> The API gains one optional parameter. No Prisma changes.

---

## Where the checks live

```
Worker loop (feature 3):            Worker loop (feature 4):
  BLPOP url                           BLPOP url
  if depth > max → skip               if depth > max → skip
  if url seen → skip                  if url seen → skip
  crawl(url)                          isAllowedByRobots(url)   ← NEW
  SADD seen                             if not allowed → skip
  INCR count                          isOnCooldown(hostname)   ← NEW
  RPUSH links                           if on cooldown → re-enqueue, skip
                                      setCooldown(hostname)    ← NEW
                                      crawl(url)
                                      SADD seen
                                      INCR count
                                      RPUSH links
```

---

## robots.txt flow

```
isAllowedByRobots("https://www.nyu.edu/about.html")
  │
  │  hostname = "www.nyu.edu"
  │  path     = "/about.html"
  ▼
GET robots:www.nyu.edu   (Redis)
  │
  ├─ hit  ──▶ parse cached rules
  │           check if path is disallowed
  │           return true/false
  │
  └─ miss
       │
       ▼
    fetch "https://www.nyu.edu/robots.txt"
       │
       ├─ 200 OK  ──▶ parse rules
       │              SET robots:www.nyu.edu <rules> EX 86400
       │              check if path is disallowed
       │              return true/false
       │
       └─ 404 / error ──▶ SET robots:www.nyu.edu "allow-all" EX 86400
                           return true (allow)
```

**robots.txt parsing — minimal implementation:**

```
Raw robots.txt for nyu.edu:
  User-agent: *
  Disallow: /private/
  Disallow: /wp-admin/
  Crawl-delay: 1

Our parser extracts:
  {
    disallow: ["/private/", "/wp-admin/"],
    crawlDelay: 1
  }

Check "/about.html":
  "/about.html".startsWith("/private/") → false
  "/about.html".startsWith("/wp-admin/") → false
  → allowed ✓

Check "/private/docs.html":
  "/private/docs.html".startsWith("/private/") → true
  → disallowed ✗
```

---

## Rate limiting flow

```
isOnCooldown("www.nyu.edu")
  │
  ▼
GET crawl-delay:www.nyu.edu   (Redis)
  │
  ├─ exists ──▶ return true (on cooldown)
  │             worker re-enqueues url at tail and continues
  │
  └─ missing ──▶ return false (ok to crawl)
                 setCooldown("www.nyu.edu", 2s)
                   → SET crawl-delay:www.nyu.edu 1 EX 2
                 proceed to crawl(url)
```

**Why re-enqueue instead of sleep:**

```
sleep approach (bad):
  host on cooldown → sleep 2s → crawl
  during those 2s: worker is blocked, no other URLs processed

re-enqueue approach (good):
  host A on cooldown → re-enqueue A → process host B → process host C
  → eventually A's cooldown expires → A gets crawled
  during cooldown: worker keeps processing other hosts
```

---

## Concrete example — crawling nyu.edu with politeness

```
Iteration 1:
  url = "https://www.nyu.edu"  hostname = "www.nyu.edu"
  robots: cache miss → fetch robots.txt → cache for 24h → allowed ✓
  cooldown: GET crawl-delay:www.nyu.edu → missing → ok
  SET crawl-delay:www.nyu.edu EX 2
  crawl("https://www.nyu.edu") → 43 links
  RPUSH 43 links

Iteration 2 (immediately after):
  url = "https://www.nyu.edu/academics.html"  hostname = "www.nyu.edu"
  robots: cache HIT → allowed ✓
  cooldown: GET crawl-delay:www.nyu.edu → EXISTS (still in 2s window)
  re-enqueue "https://www.nyu.edu/academics.html" at tail
  continue → pick next url

  url = "https://allnyu.nyu.edu/"  hostname = "allnyu.nyu.edu"
  robots: cache miss → fetch allnyu.nyu.edu/robots.txt → cache → allowed ✓
  cooldown: GET crawl-delay:allnyu.nyu.edu → missing → ok
  SET crawl-delay:allnyu.nyu.edu EX 2
  crawl("https://allnyu.nyu.edu/") → links

  [2 seconds pass, crawl-delay:www.nyu.edu key expires]

Iteration N:
  url = "https://www.nyu.edu/academics.html" (came back around from tail)
  robots: cache HIT → allowed ✓
  cooldown: GET crawl-delay:www.nyu.edu → missing (expired) → ok
  SET crawl-delay:www.nyu.edu EX 2
  crawl("https://www.nyu.edu/academics.html") → links
```

---

## Redis keys after feature 4

```
frontier:<jobId>          LIST    BFS queue
frontier:<jobId>:count    STRING  pages crawled
seen-urls:<jobId>         SET     crawled finalUrls
crawl-delay:<hostname>    STRING  exists = on cooldown, auto-expires  ← NEW
robots:<hostname>         STRING  cached robots rules, 24h TTL        ← NEW
```

`crawl-delay` keys expire automatically - no cleanup needed.
`robots` keys survive across jobs - fetched once per host per 24h.

---

## What changes vs feature 3

| File | Change |
|---|---|
| `frontier.service.ts` | add robots check + cooldown check before crawl |
| `lib/robots.ts` | NEW - fetch, parse, cache robots.txt |
| `lib/rateLimit.ts` | NEW - isOnCooldown, setCooldown helpers |
| Everything else | unchanged |
