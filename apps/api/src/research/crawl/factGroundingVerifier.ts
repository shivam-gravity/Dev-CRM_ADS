import type { ExtractedFact } from "./crawlPersistence.js";
import { logger } from "../../modules/logger/logger.js";

/**
 * Measured value-grounding verification for extracted facts.
 *
 * The fact extractor (factExtraction.ts) is an LLM that returns each fact with a SELF-REPORTED
 * `confidence` and a SELF-ATTRIBUTED `sourceUrl`. Nothing downstream checked either against the
 * actual crawled page text — so a paraphrased, misattributed, or outright hallucinated value
 * persisted at whatever confidence the model claimed, and that self-reported number then drove
 * factGroundingScore (which floors overall research confidence at 0.8). This module replaces that
 * trust-the-model step with a MEASURED one: does the value actually appear in the crawled text?
 *
 * It is deliberately pure (no I/O, no LLM) so it's cheap (string ops over ~40 facts) and fully
 * unit-testable. The output `confidence` is the measured grounding score, NOT the model's guess.
 */

export interface PageText {
  url: string;
  text: string;
}

/** A fact whose confidence is now a MEASURED grounding score, with provenance corrected to the
 * page its value was actually found in. */
export interface GroundedFact extends ExtractedFact {
  /** The measured token-overlap grounding score in [0,1] — this is what `confidence` is set to. */
  groundingScore: number;
  /** True when the value was found in the page it CLAIMED as its source (provenance was honest). */
  sourceMatched: boolean;
}

// A value scoring below this against every crawled page is treated as ungrounded (hallucinated or
// about some other business) and dropped — a "concrete, verifiable claim" that appears in NONE of
// the crawled text has no business grounding downstream agents. Env-tunable for stricter/looser runs.
export const GROUNDING_DROP_THRESHOLD = clamp01(Number(process.env.FACT_GROUNDING_DROP_THRESHOLD) || 0.34);

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

/** Lowercase, collapse every run of non-alphanumeric characters to a single space, trim. So
 * "Starts at $1,299/mo!" → "starts at 1 299 mo" — punctuation/casing/whitespace differences between
 * a model's paraphrase and the source text no longer cause spurious mismatches. */
function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Number groups in a string, with thousands-separator commas removed but decimals kept, so a
 * price "$1,299.00" and page text "1299" compare equal on the integer part. Returns the raw number
 * tokens (e.g. ["1299.00"]) for a "the distinctive number must actually appear" guard. */
function numberTokens(normalized: string): string[] {
  // normalized has already collapsed punctuation to spaces, so "1,299.00" became "1 299 00" — that
  // loses the grouping. Run this on the ORIGINAL string instead (see caller), matching digit groups
  // that may contain commas/dots, then strip commas.
  const matches = normalized.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return matches.map((m) => m.replace(/,/g, "")).filter((m) => m.length > 0);
}

/**
 * Grounding score of one value against one page's text, in [0,1].
 *   1.0  — the normalized value is a verbatim substring of the normalized page text.
 *   else — fraction of the value's SIGNIFICANT tokens (len ≥ 3, or any token containing a digit)
 *          that appear in the page text.
 * Numeric guard: a concrete claim's distinguishing power is its numbers (prices, counts, %). If a
 * number in the value does NOT appear in the page, the value isn't really backed by that page — the
 * score is capped at 0.49 so a "$49/mo" invented for a page that never mentions 49 can't score high
 * on its filler words alone.
 */
export function groundingScoreAgainstPage(value: string, pageText: string): number {
  const normValue = normalizeText(value);
  const normText = normalizeText(pageText);
  if (!normValue) return 0;
  if (!normText) return 0;

  // Verbatim (post-normalization) — the strongest possible grounding.
  if (normText.includes(normValue)) return 1;

  const tokens = normValue.split(" ").filter(Boolean);
  const significant = tokens.filter((t) => t.length >= 3 || /\d/.test(t));
  const pool = significant.length > 0 ? significant : tokens;
  if (pool.length === 0) return 0;

  // Token overlap: a normalized token is "present" if it appears anywhere in the normalized text.
  // Wrap in spaces so a short token matches a whole word, not an incidental substring.
  const paddedText = ` ${normText} `;
  const matched = pool.filter((t) => paddedText.includes(` ${t} `) || normText.includes(t)).length;
  let score = matched / pool.length;

  // Numeric guard — every number in the value must be present in the page, or the claim isn't backed.
  const valueNumbers = numberTokens(value);
  if (valueNumbers.length > 0) {
    const pageNumbers = new Set(numberTokens(pageText));
    const allNumbersPresent = valueNumbers.every((n) => pageNumbers.has(n));
    if (!allNumbersPresent) score = Math.min(score, 0.49);
  }

  return clamp01(Math.round(score * 100) / 100);
}

/**
 * Verify a batch of extracted facts against the crawled pages. For each fact:
 *   - Score its value against EVERY page; take the best-scoring page.
 *   - Prefer the fact's claimed sourceUrl on a tie (honest provenance shouldn't be penalized).
 *   - Set `confidence` to the MEASURED score (self-reported confidence is discarded — it was the
 *     untrustworthy input this whole module exists to replace).
 *   - Correct `sourceUrl` to the page the value was actually found in (fixes misattribution and the
 *     "attributed to a page not in the crawl" case).
 *   - DROP facts whose best score is below GROUNDING_DROP_THRESHOLD (present in no page → ungrounded).
 * Logs a one-line summary of how many were kept / rescored / dropped for observability.
 */
export function verifyFactGrounding(facts: ExtractedFact[], pages: PageText[]): GroundedFact[] {
  if (facts.length === 0) return [];
  const usablePages = pages.filter((p) => p.text && p.text.trim().length > 0);
  if (usablePages.length === 0) {
    // Nothing to verify against — don't silently pass self-reported confidence through as if
    // measured. Cap at a modest ceiling and flag ungrounded provenance, but keep the facts.
    return facts.map((f) => ({ ...f, confidence: Math.min(clamp01(f.confidence), 0.5), groundingScore: 0, sourceMatched: false }));
  }

  const byUrl = new Map(usablePages.map((p) => [normalizeUrlKey(p.url), p]));
  const kept: GroundedFact[] = [];
  let dropped = 0;

  for (const fact of facts) {
    let bestScore = 0;
    let bestUrl: string | null = null;

    // Claimed page first, so an honest attribution wins ties over an incidental match elsewhere.
    const claimed = fact.sourceUrl ? byUrl.get(normalizeUrlKey(fact.sourceUrl)) : undefined;
    if (claimed) {
      bestScore = groundingScoreAgainstPage(fact.value, claimed.text);
      bestUrl = claimed.url;
    }
    for (const page of usablePages) {
      if (claimed && page.url === claimed.url) continue;
      const score = groundingScoreAgainstPage(fact.value, page.text);
      if (score > bestScore) {
        bestScore = score;
        bestUrl = page.url;
      }
    }

    if (bestScore < GROUNDING_DROP_THRESHOLD) {
      dropped++;
      continue;
    }

    kept.push({
      field: fact.field,
      value: fact.value,
      sourceUrl: bestUrl ?? fact.sourceUrl,
      confidence: bestScore, // MEASURED grounding, not the model's self-report
      groundingScore: bestScore,
      sourceMatched: !!claimed && bestUrl === claimed.url,
    });
  }

  logger.info(
    `verifyFactGrounding: ${kept.length}/${facts.length} facts grounded in crawled text ` +
      `(${dropped} dropped as ungrounded, ${kept.filter((f) => !f.sourceMatched).length} re-attributed to their real source page)`,
  );
  return kept;
}

/** Loose URL key for matching a fact's claimed sourceUrl to a crawled page — origin+pathname, no
 * trailing slash/query, lowercased. Mirrors persistCrawlFacts' resolver so the two agree. */
function normalizeUrlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}
