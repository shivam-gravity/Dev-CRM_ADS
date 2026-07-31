import * as cheerio from "cheerio";
import { discoverAndSelectPages } from "../../modules/onboarding/scraper.js";
import { logger } from "../../modules/logger/logger.js";
import type { ResearchProvider } from "../interfaces/ResearchProvider.js";
import type { ProviderResult, ResearchProviderInput, SEOData } from "../types/index.js";
import { normalizeUrl, runProviderStep } from "./support.js";

/**
 * Budget for ONE page fetch, covering connect + headers + the full body read.
 *
 * It used to be 8s enforced two ways at once: an AbortController armed before the request AND a
 * withTimeout around the fetch promise. But `fetch` resolves as soon as the HEADERS arrive, so the
 * still-armed controller went on to abort the body stream during `res.text()`. On prod that killed
 * this provider 18 times out of 19 with a bare "This operation was aborted", and because the entry
 * page throws, the whole provider failed — leaving `context.keywords` null for the agents
 * downstream. One budget, one mechanism, and generous enough to actually read a marketing page.
 */
const FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.SEO_FETCH_TIMEOUT_MS ?? 15_000));
const MAX_KEYWORDS = 12;
// Entry page + up to this many more same-origin pages — deliberately smaller than
// WebsiteProvider's SMART_CRAWL_CAP (15): this provider only needs enough page diversity
// for keyword frequency to stop being dominated by one page's boilerplate, not a full
// site crawl (that's WebsiteProvider's job; duplicating its full crawl here would double
// the site's request load for every research job for no real benefit).
const MAX_ADDITIONAL_PAGES = 4;
const DATA_SOURCE = "On-page meta tags + keyword-frequency analysis (multi-page)";
// Labeled distinctly so a run's provenance stays honest: this pass read the pre-rendered crawl,
// not the raw markup, so it has no <meta> tags and only one page's worth of text behind it.
const FALLBACK_DATA_SOURCE = "Keyword-frequency analysis of the pre-rendered site crawl (direct page fetch unavailable)";

// Common English stopwords + a few markup/boilerplate terms that would otherwise
// dominate frequency counts on almost any page.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "is", "are", "was", "were",
  "be", "been", "being", "this", "that", "these", "those", "it", "its", "as", "at", "by", "from", "we", "you",
  "your", "our", "us", "they", "their", "them", "he", "she", "his", "her", "i", "not", "have", "has", "had",
  "will", "would", "can", "could", "about", "into", "more", "all", "if", "do", "does", "so", "than", "then",
  "up", "out", "no", "yes", "how", "what", "when", "where", "who", "which", "also", "get", "using",
]);

function extractKeywords(bodyText: string): string[] {
  const counts = new Map<string, number>();
  const words = bodyText.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_KEYWORDS)
    .map(([word]) => word);
}

async function fetchAndClean(url: string): Promise<cheerio.CheerioAPI> {
  // ONE deadline for the whole exchange. AbortSignal.timeout stays armed across the body read, so
  // a slow body is aborted by the same budget rather than by a timer that was only meant to cover
  // the headers — and nothing races the promise separately and leaves the request running.
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PolluxaResearchBot/1.0)" },
  });
  if (!res.ok) throw new Error(`Site responded with ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, nav, footer").remove();
  return $;
}

/**
 * Markdown headings ("# ...", "## ...") out of the orchestrator's prefetched excerpt — the
 * fallback's stand-in for the <h1>/<h2> scrape.
 */
function headingsFromMarkdown(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => /^#{1,3}\s+(.*)$/.exec(line.trim())?.[1]?.trim())
    .filter((h): h is string => Boolean(h))
    .slice(0, 15);
}

/**
 * On-page SEO signal extraction (meta title/description, headings, top keywords by
 * frequency) — independent of every other provider. No OpenAI dependency: keyword
 * extraction is a plain frequency heuristic, so this provider works identically with or
 * without an API key. Meta title/description/headings come from the entry page only
 * (that's what a search result actually shows), but keyword frequency is computed across
 * the entry page plus a handful of other same-origin pages (reusing scraper.ts's
 * sitemap/link discovery) so one page's boilerplate can't dominate the keyword list.
 */
export class SEOProvider implements ResearchProvider<SEOData> {
  readonly name = "seo";
  readonly priority = 80;

  async execute(input: ResearchProviderInput): Promise<ProviderResult<SEOData>> {
    return runProviderStep(this.name, 1, input, async () => {
      const url = normalizeUrl(input.url);

      // A plain fetch is the best source here (real <title>/<meta>/<h1> markup), but it is also the
      // most fragile: SPAs ship an empty shell, and plenty of sites 403 a bot User-Agent outright.
      // When it fails, DON'T fail the provider — the orchestrator already rendered this exact site
      // in a headless browser during the up-front prefetch and handed every provider the result.
      // Falling back to it costs nothing, needs no network, and works on precisely the bot-blocked
      // and JS-rendered sites the direct fetch cannot handle. `seo` is a CORE provider, so failing
      // it left context.keywords null for every downstream agent.
      const entry$ = await fetchAndClean(url).catch((err) => {
        logger.warn(`SEOProvider: direct fetch of ${url} failed (${err instanceof Error ? err.message : err}) — falling back to the prefetched site excerpt`);
        return null;
      });

      const metaTitle = entry$?.("title").first().text().trim() || undefined;
      const metaDescription =
        entry$?.('meta[name="description"]').attr("content")?.trim() ||
        entry$?.('meta[property="og:description"]').attr("content")?.trim() ||
        undefined;
      const headings = entry$
        ? entry$("h1, h2").map((_, el) => entry$(el).text().trim()).get().filter(Boolean).slice(0, 15)
        : headingsFromMarkdown(input.websiteExcerpt ?? "");

      const bodyTexts = entry$
        ? [entry$("body").text().replace(/\s+/g, " ").trim()]
        : [(input.websiteExcerpt ?? "").replace(/\s+/g, " ").trim()].filter(Boolean);

      // Secondary pages need the entry document's links to discover them, so this only runs on the
      // direct-fetch path. The excerpt fallback is single-page by nature — reflected honestly in the
      // confidence score below, which withholds the multi-page bonus.
      if (entry$) {
        const { toCrawl } = await discoverAndSelectPages(url, entry$).catch(() => ({ toCrawl: [] }));
        for (const { url: pageUrl } of toCrawl.slice(0, MAX_ADDITIONAL_PAGES)) {
          try {
            const $ = await fetchAndClean(pageUrl);
            bodyTexts.push($("body").text().replace(/\s+/g, " ").trim());
          } catch {
            // A secondary page failing to load shouldn't sink keyword extraction from the rest.
          }
        }
      }

      const data: SEOData = {
        primaryKeywords: extractKeywords(bodyTexts.join(" ")),
        metaTitle,
        metaDescription,
        headings,
        dataSource: entry$ ? DATA_SOURCE : FALLBACK_DATA_SOURCE,
      };

      // Confidence by EXTRACTION COMPLETENESS, not the default citation scorer. This provider
      // reads the real page directly (no LLM, no web citations), so the default scorer pinned it
      // at a flat 0.6 no matter how complete the extraction was — undervaluing genuine first-party
      // on-page grounding. Score the four on-page signals we actually captured (title, description,
      // headings, a full keyword list): a page that yielded all four is strong SEO grounding and
      // earns up to 0.9; a near-empty page honestly scores low. Deterministic and first-party.
      const pagesAnalyzed = bodyTexts.length;
      const signals =
        (metaTitle ? 0.2 : 0) +
        (metaDescription ? 0.2 : 0) +
        (headings.length >= 3 ? 0.2 : headings.length > 0 ? 0.1 : 0) +
        (data.primaryKeywords.length >= MAX_KEYWORDS ? 0.2 : data.primaryKeywords.length > 0 ? 0.1 : 0) +
        (pagesAnalyzed > 1 ? 0.1 : 0); // multi-page keyword base is less boilerplate-biased
      const confidence = data.primaryKeywords.length === 0
        ? 0.3 // essentially nothing extracted — honest low score
        : Math.round(Math.min(0.5 + signals, 0.9) * 100) / 100;

      return { status: data.primaryKeywords.length > 0 ? "success" : "partial", data, confidence };
    });
  }
}
