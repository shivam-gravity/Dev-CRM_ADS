import * as llmRouter from "../../infra/llmRouter.js";
import { resolveTaskModel } from "../../infra/llmTaskConfig.js";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../modules/logger/logger.js";
import { persistCrawlFacts, type ExtractedFact } from "./crawlPersistence.js";
import { verifyFactGrounding, type PageText } from "./factGroundingVerifier.js";

const MAX_CONTENT_CHARS = 18_000;
// Below this, a page is either an unscored fallback-discovery link or a genuinely
// low-priority sitemap entry (e.g. old blog posts) — see discoverAndSelectPages in
// scraper.ts: the no-sitemap fallback path floors every candidate at 0.5, so this never
// excludes anything there, only the sitemap path's genuinely low-declared-priority pages.
const MIN_RELEVANCE_FOR_FACTS = 0.3;

const FACT_EXTRACTION_TOOL = {
  name: "emit_crawl_facts",
  description: "Return every concrete, verifiable fact found in the crawled website pages, each with its source page URL and a confidence score.",
  input_schema: {
    type: "object" as const,
    properties: {
      facts: {
        type: "array",
        description:
          "Concrete, verifiable claims only (prices, product names, named customers, guarantees, plan tiers) — no opinions or summaries.",
        items: {
          type: "object",
          properties: {
            field: { type: "string", description: "Dot-path label, e.g. pricing.startingPrice, product.name, usp, guarantee, notableCustomer" },
            value: { type: "string" },
            sourceUrl: { type: "string", description: "The crawled page URL this fact was read from — must be one of the [Page: ...] URLs in the prompt" },
            confidence: { type: "number", description: "0-1" },
          },
          required: ["field", "value", "sourceUrl", "confidence"],
        },
      },
    },
    required: ["facts"],
  },
};

/**
 * Standalone fact extraction over a persisted crawl's pages — one structured LLM call that
 * turns CrawlPage.cleanedText into CrawlFact rows (fact -> source page -> confidence).
 *
 * This is what makes the main campaign-generation pipeline fact-grounded: the onboarding
 * deep-research path extracts facts as a side effect of analyzeProduct/analyzeAudience
 * (modules/onboarding/analysis.ts), but the research-orchestrator path only persists pages,
 * so without this step the fact-grounded agents (creative/campaign/critic) would always see
 * an empty facts list for pipeline-generated campaigns.
 *
 * Returns the number of facts persisted. 0 (never a throw upward from missing data) when
 * the crawl has no pages or no model is configured — real facts or none, no fallback facts.
 */
// The PRIMARY cause of empty extractions was the 2048-token truncation (now 4096), which the
// bimodal 30-or-0 behavior masked. With that fixed, one retry is enough to ride out the rare
// residual transient-empty without paying for multiple serial ~15s LLM calls on every run (the
// old default of 2 retries added up to ~45s of dead latency when the model was genuinely empty).
// Bump FACT_EXTRACTION_EMPTY_RETRIES via env if a specific site still needs more.
const FACT_EXTRACTION_EMPTY_RETRIES = Math.max(0, Number(process.env.FACT_EXTRACTION_EMPTY_RETRIES ?? 1));

/** One fact-extraction pass (with retry-on-empty) over pre-packed content. Returns [] (never
 * throws) only when every attempt comes back empty, so callers can still retry with narrower input.
 *
 * Tool use is already FORCED (bedrockClient toolChoice), yet the model intermittently calls
 * emit_crawl_facts with an EMPTY array on content that a moment earlier yielded 30+ facts — a
 * known source of run-to-run swings. A couple of retries recover the common transient-empty case;
 * a persistently-empty response (the model genuinely declining) is left to the caller's
 * narrower-input fallback. */
async function runFactExtraction(content: string): Promise<ExtractedFact[]> {
  if (!content.trim()) return [];
  for (let attempt = 0; attempt <= FACT_EXTRACTION_EMPTY_RETRIES; attempt++) {
    const { data: result } = await llmRouter.runStructured<{ facts: ExtractedFact[] }>(resolveTaskModel("crawl-fact-extraction"), {
      // 4096, not 2048: a fact-rich homepage yields 30+ facts, and at 2048 the forced tool-call
      // JSON gets TRUNCATED at max_tokens mid-array — Converse then returns an empty/!invalid
      // toolUse.input, which surfaced as "0 facts" and was the real cause of the bimodal 30-or-0
      // extraction (and thus the run-to-run confidence swings). The larger budget lets the whole
      // fact array complete. (The retry-on-empty below still covers genuine transient empties.)
      maxTokens: 4096,
      tool: FACT_EXTRACTION_TOOL,
      messages: [
        {
          role: "user",
          content: `Extract every concrete, verifiable fact from these crawled website pages. For each fact give the exact page URL it came from and your confidence in it.\n\n${content}`,
        },
      ],
    });
    const facts = result && Array.isArray(result.facts) ? result.facts : [];
    if (facts.length > 0) return facts;
  }
  return [];
}

export async function extractAndPersistCrawlFacts(crawlJobId: string): Promise<number> {
  const pages = await prisma.crawlPage.findMany({
    where: { crawlJobId, cleanedText: { not: null }, relevanceScore: { gte: MIN_RELEVANCE_FOR_FACTS } },
    orderBy: { relevanceScore: "desc" },
    select: { url: true, cleanedText: true, contentHash: true },
  });
  if (pages.length === 0) return 0;

  // Greedily packs whole pages (highest relevance first) into the char budget rather than
  // joining everything and slicing the result afterward — a blind post-join slice can cut a
  // page off mid-sentence at an arbitrary point, feeding the model a garbled tail instead of
  // simply not including a lower-relevance page. Exact-duplicate pages (same contentHash —
  // templated legal/boilerplate pages are the common case) are skipped outright: they cost
  // tokens without adding any fact the first copy didn't already offer.
  const seenHashes = new Set<string>();
  const parts: string[] = [];
  let remaining = MAX_CONTENT_CHARS;
  for (const p of pages) {
    // contentHash is nullable in the schema even though persistCrawlPages always sets it —
    // fall back to a per-page-unique key so a hypothetical null hash never wrongly dedupes
    // two unrelated pages against each other.
    const hashKey = p.contentHash ?? `no-hash:${p.url}`;
    if (seenHashes.has(hashKey)) continue;
    seenHashes.add(hashKey);
    const block = `[Page: ${p.url}]\n${p.cleanedText}`;
    if (block.length > remaining) {
      if (parts.length === 0) parts.push(block.slice(0, remaining)); // still give the model SOMETHING even if the single highest-relevance page alone blows the budget
      break;
    }
    parts.push(block);
    remaining -= block.length + 2; // "\n\n" join below
  }
  const content = parts.join("\n\n");

  let facts = await runFactExtraction(content);
  // Resilience fallback: a single concatenated call over several pages sometimes returns ZERO
  // facts when long narrative pages (e.g. case studies / blog posts) dilute the fact-dense
  // homepage — observed live: polluxa.com homepage ALONE yields 25 facts, but homepage + 2
  // case-study pages returns 0. When the combined pass comes back empty but we have more than
  // one page, retry with ONLY the highest-relevance page (pages[0], relevance-sorted above), which
  // is almost always the fact-rich homepage. One real page beats an empty result that ungrounds
  // every downstream agent.
  if (facts.length === 0 && pages.length > 1) {
    const top = pages[0];
    logger.info(`extractAndPersistCrawlFacts: combined pass returned 0 facts for crawl ${crawlJobId} — retrying with the top page only (${top.url})`);
    facts = await runFactExtraction(`[Page: ${top.url}]\n${(top.cleanedText ?? "").slice(0, MAX_CONTENT_CHARS)}`);
  }
  if (facts.length === 0) {
    logger.info(`extractAndPersistCrawlFacts: model returned no facts for crawl ${crawlJobId}`);
    return 0;
  }

  // Measured grounding: verify each extracted value against the actual crawled page text before
  // persisting. Replaces the model's self-reported per-fact confidence with a measured score,
  // corrects misattributed source pages, and drops values that appear in NO crawled page (the
  // hallucinated/other-business case). The self-reported confidence never reaches the DB.
  const pageText: PageText[] = pages.map((p) => ({ url: p.url, text: p.cleanedText ?? "" }));
  const grounded = verifyFactGrounding(facts, pageText);
  if (grounded.length === 0) {
    logger.info(`extractAndPersistCrawlFacts: all ${facts.length} extracted facts failed grounding verification for crawl ${crawlJobId}`);
    return 0;
  }

  return persistCrawlFacts(crawlJobId, grounded);
}

/**
 * In-memory sibling of extractAndPersistCrawlFacts: turns already-crawled page text into a
 * source-attributed fact table with ONE structured LLM call, WITHOUT touching the DB. This is
 * the heart of the fact-first pipeline — the orchestrator runs it once up-front, then the
 * business-identity providers reason from the returned facts instead of each making their own
 * search+LLM call. Collapsing ~17 per-provider retrieval calls into this single extraction is
 * what cuts token use (and free-tier throttling) while keeping every claim pinned to a real URL.
 *
 * `pages` is the refined crawl output (already boilerplate-stripped). Returns [] — never throws
 * upward — when there's no content or no model, so callers degrade to their prior search path.
 */
export async function extractFactsFromPages(
  pages: { url: string; text: string }[]
): Promise<ExtractedFact[]> {
  const usable = pages.filter((p) => p.text && p.text.trim().length > 0);
  if (usable.length === 0) return [];

  // Same greedy whole-page packing as the persisted path: fill the char budget with the
  // highest-value pages intact rather than blindly slicing a concatenation mid-sentence.
  const parts: string[] = [];
  let remaining = MAX_CONTENT_CHARS;
  for (const p of usable) {
    const block = `[Page: ${p.url}]\n${p.text}`;
    if (block.length > remaining) {
      if (parts.length === 0) parts.push(block.slice(0, remaining));
      break;
    }
    parts.push(block);
    remaining -= block.length + 2;
  }
  const content = parts.join("\n\n");

  try {
    let facts = await runFactExtraction(content);
    // Same resilience fallback as the persisted path: if a multi-page concatenation returns zero
    // facts (long narrative pages diluting a fact-dense homepage), retry with only the first
    // (highest-value) page rather than handing providers an empty fact table.
    if (facts.length === 0 && usable.length > 1) {
      facts = await runFactExtraction(`[Page: ${usable[0].url}]\n${usable[0].text.slice(0, MAX_CONTENT_CHARS)}`);
    }
    // Same measured-grounding verification as the persisted path: the facts feeding the fact-first
    // providers (structureFromFacts → factGroundingScore) carry a MEASURED confidence, not the
    // model's self-report, and values grounded in no crawled page are dropped before they can
    // inflate a provider's grounding score.
    return verifyFactGrounding(facts, usable);
  } catch (err) {
    logger.warn("extractFactsFromPages: fact extraction failed — providers fall back to their search path", err);
    return [];
  }
}
