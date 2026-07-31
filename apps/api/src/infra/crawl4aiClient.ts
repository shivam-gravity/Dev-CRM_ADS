import { logger } from "../modules/logger/logger.js";
import type { ScrapeData, ScrapeFormat, MapLink, CrawlPage, ScrapeOutage } from "./scrapeTypes.js";

/**
 * Client for the self-hosted crawl4ai service (docker-compose.yml's `crawl4ai` service,
 * image `unclecode/crawl4ai`). Replaces the removed firecrawlClient.ts. Because crawl4ai is
 * self-hosted and reachable only on this platform's own network, there is no API key and no
 * per-call credit budget — "not configured" means `CRAWL4AI_BASE_URL` isn't set (no instance
 * deployed in this environment), which every caller already handles identically to the old
 * "no-key" outage: label the result partial, never throw.
 *
 * The public surface (crawl4aiScrape/crawl4aiMap/crawl4aiCrawl + neutral return shapes) mirrors
 * the old firecrawl wrappers 1:1 so scrapeFallback.ts and the direct-scrape providers
 * (ReviewsProvider/SocialMediaProvider) change only their import, not their call shape.
 */

// Read fresh on every call rather than frozen at module load — this module is a singleton
// across an entire `npm test` run, so a const captured at first import would be immune to a
// later test's env changes (same reasoning firecrawlClient.ts documented for its key getter).
function crawl4aiBaseUrl(): string | undefined {
  return process.env.CRAWL4AI_BASE_URL;
}

// Optional bearer token — crawl4ai can be started with CRAWL4AI_API_TOKEN to require auth.
// When unset (the common self-hosted-on-private-network case) no Authorization header is sent.
function crawl4aiToken(): string | undefined {
  return process.env.CRAWL4AI_API_TOKEN;
}

// Must exceed the crawler's own page_timeout (below) or the HTTP request aborts before crawl4ai
// finishes rendering — which produced the AbortError storm on networkidle waits. 40s > 25s page.
const REQUEST_TIMEOUT_MS = 40_000;

export const CRAWL4AI_NO_URL_DATA_SOURCE = "crawl4ai not configured (CRAWL4AI_BASE_URL not set)";

/**
 * Global concurrency cap on in-flight crawl4ai requests. crawl4ai renders each URL in a real
 * headless browser from a small pool (a handful of workers); the research pipeline fans out
 * dozens of providers, each of which may crawl several URLs, so WITHOUT a cap the client fired
 * 100+ simultaneous crawls, saturated the browser pool, and every request then timed out at
 * 30s — enrichment silently degraded to thin snippets exactly when it mattered. This semaphore
 * bounds concurrency so crawls queue in-process and each still completes fast, instead of all
 * of them stampeding the server and all failing. Tunable via CRAWL4AI_MAX_CONCURRENCY.
 */
const MAX_CONCURRENCY = Math.max(1, Number(process.env.CRAWL4AI_MAX_CONCURRENCY ?? 4));

/**
 * How long a caller will WAIT for a slot before giving up and degrading.
 *
 * The wait used to be unbounded, and that was the single worst latency bug in research. Worst case
 * one crawl holds a slot for REQUEST_TIMEOUT_MS × (1 + CRAWL4AI_MAX_RETRIES) + backoff ≈ 122s; with
 * MAX_CONCURRENCY=2 on a small box, two of those starve every other caller indefinitely. The
 * research fan-out then sat in this queue until the ORCHESTRATOR's 150s per-provider ceiling fired,
 * so a provider reported "timed out" having never made a single request. Measured on prod: the
 * `search` provider failed 19/19 times, every one at exactly 150000ms, which set a hard ~301s floor
 * (two attempts) under every research run regardless of the site.
 *
 * Bounding the wait converts that silent stall into a fast, honest degrade: no slot in time → the
 * caller returns null → the provider falls back to its snippet/excerpt path and still produces a
 * result. Must stay well under the orchestrator's PROVIDER_TIMEOUT_MS or it just moves the stall.
 */
const SLOT_WAIT_TIMEOUT_MS = Math.max(1_000, Number(process.env.CRAWL4AI_SLOT_WAIT_TIMEOUT_MS ?? 20_000));

let inFlight = 0;
/** FIFO queue of waiters. `notify` hands the slot over directly (see releaseSlot). */
const waiters: { notify: () => void }[] = [];

/**
 * Returns true if a slot was acquired (caller MUST releaseSlot), false if the wait timed out.
 *
 * On release the slot is handed DIRECTLY to the next waiter rather than decrementing and letting
 * it re-race: without that handoff a caller arriving synchronously between the decrement and the
 * woken waiter's increment could take the slot too, briefly over-subscribing the browser pool the
 * semaphore exists to protect.
 */
async function acquireSlot(): Promise<boolean> {
  if (inFlight < MAX_CONCURRENCY) {
    inFlight += 1;
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    const waiter = {
      notify: () => {
        clearTimeout(timer);
        resolve(true); // the slot was handed over already-counted — do NOT increment here
      },
    };
    const timer = setTimeout(() => {
      // Drop out of the queue, or releaseSlot would hand a slot to a caller that has already
      // given up — leaking inFlight until the process restarts.
      const i = waiters.indexOf(waiter);
      if (i !== -1) waiters.splice(i, 1);
      resolve(false);
    }, SLOT_WAIT_TIMEOUT_MS);
    waiters.push(waiter);
  });
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    next.notify(); // hand the slot over; inFlight stays as-is because ownership transferred
    return;
  }
  inFlight -= 1;
}

function checkAvailable(): ScrapeOutage | null {
  return crawl4aiBaseUrl() ? null : "no-key";
}

interface Crawl4aiResult {
  url?: string;
  html?: string | null;
  cleaned_html?: string | null;
  // crawl4ai returns markdown either as a plain string or as an object with raw/fit variants,
  // depending on version — normalizeMarkdown() handles both.
  markdown?: string | { raw_markdown?: string; fit_markdown?: string } | null;
  links?: { internal?: { href?: string }[]; external?: { href?: string }[] } | null;
  media?: { images?: { src?: string }[] } | null;
  metadata?: { title?: string; description?: string } | null;
  screenshot?: string | null;
  success?: boolean;
  status_code?: number;
}

interface Crawl4aiResponse {
  results?: Crawl4aiResult[];
  success?: boolean;
}

function normalizeMarkdown(md: Crawl4aiResult["markdown"]): string | null {
  if (!md) return null;
  if (typeof md === "string") return md;
  return md.fit_markdown || md.raw_markdown || null;
}

function collectLinks(result: Crawl4aiResult): string[] {
  const internal = (result.links?.internal ?? []).map((l) => l.href).filter((h): h is string => !!h);
  const external = (result.links?.external ?? []).map((l) => l.href).filter((h): h is string => !!h);
  return [...internal, ...external];
}

// A crawl4ai crawl fails TRANSIENTLY under concurrent load — a 500 from a momentarily-saturated
// browser pool, or a 429/503 — and a moment later the same URL succeeds (confirmed live: the
// up-front polluxa.com/crm crawl 500'd mid-burst while other URLs crawled fine seconds apart).
// So retry these with a short backoff rather than giving up, which is what made the fact-first
// prefetch silently fall back to the expensive search path. A 4xx other than 429 is a real
// client error (bad URL/auth) and is NOT retried.
const CRAWL4AI_MAX_RETRIES = Math.max(0, Number(process.env.CRAWL4AI_MAX_RETRIES ?? 2));
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** POST to a crawl4ai endpoint, returning null (never throwing) on any failure/timeout — same
 * degrade-don't-crash contract every external client in this codebase follows. Gated by the
 * concurrency semaphore so a burst of callers queues in-process instead of stampeding the
 * server's small browser pool. Retries transient statuses with backoff. The slot is acquired
 * only after the base-URL check so an unconfigured no-op never consumes one. */
async function post<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  const base = crawl4aiBaseUrl();
  if (!base) return null;
  const token = crawl4aiToken();

  if (!(await acquireSlot())) {
    // Every crawl slot was busy for the whole wait. Degrade exactly like any other crawl failure
    // (null, never throw) so the caller falls back to its snippet/excerpt path immediately instead
    // of blocking until its own outer timeout — which is what used to burn 150s per starved
    // provider and produce nothing.
    logger.warn(`crawl4aiClient: POST ${path} gave up waiting ${SLOT_WAIT_TIMEOUT_MS}ms for a crawl slot (${MAX_CONCURRENCY} in flight) — degrading`);
    return null;
  }
  try {
    for (let attempt = 0; attempt <= CRAWL4AI_MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(new URL(path, base).toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (res.ok) return (await res.json()) as T;
        if (RETRYABLE_STATUS.has(res.status) && attempt < CRAWL4AI_MAX_RETRIES) {
          clearTimeout(timer);
          logger.warn(`crawl4aiClient: POST ${path} responded with ${res.status} (transient) — retrying (attempt ${attempt + 1}/${CRAWL4AI_MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        logger.warn(`crawl4aiClient: POST ${path} responded with ${res.status}`);
        return null;
      } catch (err) {
        if (attempt < CRAWL4AI_MAX_RETRIES) {
          clearTimeout(timer);
          logger.warn(`crawl4aiClient: POST ${path} failed (transient) — retrying (attempt ${attempt + 1}/${CRAWL4AI_MAX_RETRIES})`, err);
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        logger.warn(`crawl4aiClient: POST ${path} failed or instance unreachable`, err);
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  } finally {
    releaseSlot();
  }
}

/** Build the crawler_config crawl4ai expects, translating our neutral format list into the
 * flags that turn on screenshotting / structured extraction. */
function crawlerConfig(formats: ScrapeFormat[], extra?: Record<string, unknown>): Record<string, unknown> {
  const wantScreenshot = formats.includes("screenshot");
  const jsonFormat = formats.find((f) => typeof f === "object" && f.type === "json") as
    | { type: "json"; schema: Record<string, unknown>; prompt?: string }
    | undefined;
  return {
    // Wait for client-side rendering before capturing HTML. Many marketing sites are SPAs
    // (Next.js/React) that ship a near-empty shell and hydrate content in JS — without waiting,
    // crawl4ai returns the shell, the page reads as "thin", no facts are extracted, and research
    // falls to the slow/low-confidence search path.
    //
    // We used to wait for "networkidle", but heavy/ad-tech-laden sites (e.g. stripe.com) NEVER go
    // idle — analytics beacons, trackers and websockets keep the network busy forever — so every
    // crawl burned the full page_timeout, timed out under concurrent load, and returned 0 facts
    // (which is what dropped stripe.com research to ~50% confidence and stalled generation for
    // minutes). Measured: stripe.com took 21s with networkidle vs 5s with domcontentloaded for the
    // IDENTICAL 29KB of markdown; polluxa.com (a real SPA) returned the same 12KB either way. So
    // wait for DOM ready + a fixed settle delay that covers hydration, instead of an idle signal
    // that may never come. Override via CRAWL4AI_WAIT_UNTIL if a specific site needs it.
    wait_until: process.env.CRAWL4AI_WAIT_UNTIL ?? "domcontentloaded",
    delay_before_return_html: Number(process.env.CRAWL4AI_SETTLE_DELAY_S ?? 2),
    // 15s (was 25s): with wait_until=domcontentloaded a real page renders in ~5s, so a page still
    // not ready at 15s is almost always bot-blocked (Cloudflare JS challenge) or dead. Failing fast
    // frees the (concurrency-capped) crawl slot ~10s sooner for the next hit — a big deal because
    // the research fan-out fires many crawls that queue behind this cap. Must stay UNDER
    // REQUEST_TIMEOUT_MS (40s). Env-tunable for a site that legitimately needs longer.
    page_timeout: Number(process.env.CRAWL4AI_PAGE_TIMEOUT_MS ?? 15000),
    ...(wantScreenshot ? { screenshot: true } : {}),
    ...(jsonFormat ? { extraction_strategy: { type: "json_css", schema: jsonFormat.schema } } : {}),
    ...extra,
  };
}

function toScrapeData(result: Crawl4aiResult): ScrapeData {
  return {
    markdown: normalizeMarkdown(result.markdown),
    html: result.html ?? result.cleaned_html ?? null,
    links: collectLinks(result),
    screenshot: result.screenshot ?? null,
    metadata: {
      title: result.metadata?.title,
      description: result.metadata?.description,
      sourceURL: result.url,
      statusCode: result.status_code,
    },
  };
}

/* ─────────────────────────────  scrape (single URL)  ───────────────────────────── */

/**
 * Short-lived scrape memo, shared across every caller in the process.
 *
 * A single research run fans out ~10 providers, several of which call runWebSearch, each of which
 * enriches its top hits with a full crawl. Those hit lists overlap heavily — they are all searching
 * for the SAME business, so the same handful of pages (the business's own site, its LinkedIn, the
 * one industry article about it) get rendered again and again. Every duplicate render is a real
 * headless-browser page load competing for a MAX_CONCURRENCY-capped slot on a small box, so the
 * duplicates don't just cost CPU — they queue in front of first-time crawls and starve them.
 *
 * TTL is deliberately short: this is a within-run memo, not a content cache. Page content going a
 * few minutes stale inside one research run is not a correctness concern; serving yesterday's page
 * would be.
 */
const SCRAPE_MEMO_TTL_MS = Math.max(0, Number(process.env.CRAWL4AI_SCRAPE_MEMO_TTL_MS ?? 10 * 60_000));
const SCRAPE_MEMO_MAX_ENTRIES = 200;
type ScrapeOutcome = { data: ScrapeData | null; outage: ScrapeOutage | null };
const scrapeMemo = new Map<string, { at: number; value: ScrapeOutcome }>();
/** Concurrent callers for the same key share ONE in-flight request rather than each starting their
 * own — the TTL memo alone can't help here, since none of them has finished to populate it yet. */
const scrapeInFlight = new Map<string, Promise<ScrapeOutcome>>();

function memoKey(url: string, formats: ScrapeFormat[]): string {
  return `${url}::${JSON.stringify(formats)}`;
}

function readMemo(key: string): ScrapeOutcome | null {
  const hit = scrapeMemo.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SCRAPE_MEMO_TTL_MS) {
    scrapeMemo.delete(key);
    return null;
  }
  // Hand out a copy, not the stored object. Callers received a freshly-built result before this
  // memo existed and are entitled to treat it as theirs; sharing one instance would let any
  // caller's incidental mutation (assigning .json, trimming .links) silently rewrite what every
  // later caller sees. Shallow is enough — markdown/html are immutable strings.
  const stored = hit.value.data;
  return {
    outage: hit.value.outage,
    data: stored ? { ...stored, links: stored.links ? [...stored.links] : stored.links, metadata: { ...stored.metadata } } : null,
  };
}

function writeMemo(key: string, value: ScrapeOutcome): void {
  if (SCRAPE_MEMO_TTL_MS === 0) return;
  // Only memoize real content. Caching a null would pin a transient failure (a busy slot, a 503)
  // for the whole TTL and deny the next caller the retry that would have worked.
  if (!value.data?.markdown) return;
  if (scrapeMemo.size >= SCRAPE_MEMO_MAX_ENTRIES) {
    const oldest = scrapeMemo.keys().next().value;
    if (oldest !== undefined) scrapeMemo.delete(oldest);
  }
  scrapeMemo.set(key, { at: Date.now(), value });
}

export async function crawl4aiScrape(url: string, formats: ScrapeFormat[]): Promise<{ data: ScrapeData | null; outage: ScrapeOutage | null }> {
  const outage = checkAvailable();
  if (outage) return { data: null, outage };

  const key = memoKey(url, formats);
  const memoized = readMemo(key);
  if (memoized) return memoized;
  const pending = scrapeInFlight.get(key);
  if (pending) return await pending;

  const work = scrapeOnce(url, formats)
    .then((value) => {
      writeMemo(key, value);
      return value;
    })
    .finally(() => scrapeInFlight.delete(key));
  scrapeInFlight.set(key, work);
  return await work;
}

async function scrapeOnce(url: string, formats: ScrapeFormat[]): Promise<{ data: ScrapeData | null; outage: ScrapeOutage | null }> {
  const result = await post<Crawl4aiResponse>("/crawl", {
    urls: [url],
    crawler_config: crawlerConfig(formats),
  });
  const first = result?.results?.[0];
  if (!first?.success) return { data: null, outage: null };

  const data = toScrapeData(first);
  // "product" extraction has no direct crawl4ai analogue to Firecrawl's managed product format;
  // downstream ProductProvider derives product shape from JSON-LD in the scraper-service path.
  // Structured JSON, when requested, is surfaced via crawl4ai's extraction_strategy output.
  const jsonFormat = formats.find((f) => typeof f === "object" && f.type === "json");
  if (jsonFormat && (first as unknown as { extracted_content?: unknown }).extracted_content) {
    data.json = (first as unknown as { extracted_content?: unknown }).extracted_content;
  }
  return { data, outage: null };
}

/* ─────────────────────────────  map (link discovery)  ───────────────────────────── */

export async function crawl4aiMap(url: string, opts?: { limit?: number }): Promise<{ links: MapLink[]; outage: ScrapeOutage | null }> {
  const outage = checkAvailable();
  if (outage) return { links: [], outage };

  // crawl4ai has no dedicated "map" endpoint; a single crawl of the entry URL yields its
  // discovered internal/external links, which is exactly what Firecrawl's /map returned.
  const result = await post<Crawl4aiResponse>("/crawl", { urls: [url], crawler_config: crawlerConfig(["links"]) });
  const first = result?.results?.[0];
  if (!first?.success) return { links: [], outage: null };

  const limit = opts?.limit ?? 100;
  const seen = new Set<string>();
  const links: MapLink[] = [];
  for (const href of collectLinks(first)) {
    if (seen.has(href)) continue;
    seen.add(href);
    links.push({ url: href });
    if (links.length >= limit) break;
  }
  return { links, outage: null };
}

/* ─────────────────────────────  crawl (multi-page)  ───────────────────────────── */

export async function crawl4aiCrawl(url: string, opts: { limit?: number; formats?: ScrapeFormat[] }): Promise<{ pages: CrawlPage[]; outage: ScrapeOutage | null }> {
  const outage = checkAvailable();
  if (outage) return { pages: [], outage };

  // deep_crawl_strategy tells crawl4ai to follow internal links up to `max_pages` — this is
  // crawl4ai's equivalent of Firecrawl's async /crawl job, but returns synchronously in one
  // response rather than needing a polled job id.
  const result = await post<Crawl4aiResponse>("/crawl", {
    urls: [url],
    crawler_config: crawlerConfig(opts.formats ?? ["markdown", "links"], {
      deep_crawl_strategy: { type: "bfs", max_pages: opts.limit ?? 15 },
    }),
  });
  if (!result?.results || result.results.length === 0) return { pages: [], outage: null };

  const pages: CrawlPage[] = result.results
    .filter((r) => r.success !== false)
    .map((r) => ({
      markdown: normalizeMarkdown(r.markdown) ?? undefined,
      html: r.html ?? null,
      links: collectLinks(r),
      screenshot: r.screenshot ?? null,
      metadata: { title: r.metadata?.title, sourceURL: r.url, statusCode: r.status_code },
    }));
  return { pages, outage: null };
}

export function isCrawl4aiConfigured(): boolean {
  return !!crawl4aiBaseUrl();
}
