import { logger } from "../../modules/logger/logger.js";
import { aggregateResearch } from "../knowledge/KnowledgeAggregator.js";
import { getBusiness } from "../../modules/business/businessService.js";
import { scrapeUrlWithFallback } from "../../infra/scrapeFallback.js";
import { refineContent } from "../../infra/contentRefiner.js";
import { extractFactsFromPages } from "../crawl/factExtraction.js";
import type { ResearchProvider } from "../interfaces/ResearchProvider.js";
import { ResearchJobStateMachine } from "../state-machine/ResearchJobStateMachine.js";
import { createResearchProviders } from "../providers/index.js";
import { ProviderTimeoutError, withTimeout } from "../providers/support.js";
import type { ProviderResult, ResearchContext, ResearchJobStatus, ResearchProviderInput } from "../types/index.js";
import {
  createResearchSnapshot,
  getResearchJob,
  markResearchJobCompleted,
  markResearchJobStatus,
  recordProviderExecution,
  type ResearchJobRecord,
} from "./researchJobService.js";

export const MAX_PROVIDER_ATTEMPTS = 2;
export const PROVIDER_RETRY_DELAY_MS = 1000;
// A provider's LLM call can legitimately take a while, because the Bedrock client rides out
// 429 (ThrottlingException) backoffs + a concurrency queue (see its doc comment) rather than
// failing fast. This outer per-provider ceiling must comfortably exceed the Bedrock client's own
// retry+backoff budget, or it kills a provider mid-retry and reintroduces exactly the "company
// provider timed out" degradation the retry logic exists to prevent. Tune via env.
export const PROVIDER_TIMEOUT_MS = Number(process.env.RESEARCH_PROVIDER_TIMEOUT_MS ?? 150_000);
// How much of the up-front site crawl to hand every provider as ground-truth. Big enough to
// carry the real value proposition / product / positioning, capped so it doesn't dominate each
// provider's token budget (the refiner has already stripped boilerplate before this cap).
const WEBSITE_EXCERPT_MAX_CHARS = 6000;
// Generous: this window covers BOTH the dual crawl AND the up-front fact-extraction LLM call,
// which on the free tier may ride out 429 backoffs. It's the highest-value step in the run (its
// facts replace ~17 downstream retrieval calls), so it's worth waiting for rather than racing to
// an empty result that collapses the whole fact-first path back to junk search. Env-tunable.
const WEBSITE_PREFETCH_TIMEOUT_MS = Number(process.env.WEBSITE_PREFETCH_TIMEOUT_MS ?? 120_000);

export interface WebsitePrefetch {
  excerpt?: string;
  facts: { field: string; value: string; sourceUrl?: string; confidence: number }[];
}

/**
 * Best-effort industry/category string from the verified facts, for grounding category-sensitive
 * provider searches (competitor discovery especially). Deterministic, no LLM: prefer an explicit
 * category/industry fact, else the product description/tagline, else the product name. Returns
 * undefined when the facts carry nothing usable (crawl failed) — callers already handle that.
 */
export function deriveIndustry(facts: WebsitePrefetch["facts"]): string | undefined {
  if (!facts?.length) return undefined;
  // Prefer an explicit category/industry fact, then a concrete product/offering descriptor, and
  // only fall back to a tagline/positioning line last — a marketing tagline ("The Future of
  // Commerce") makes a WORSE competitor-search query than a plain product category ("ERP/CRM
  // software"), so it's the lowest-priority source, not a middle one.
  const byPriority = [
    (f: { field: string }) => /category|industry|vertical/i.test(f.field),
    (f: { field: string }) => /product\.(name|type|description)|producttype|offering|software|platform|solution/i.test(f.field),
    (f: { field: string }) => /tagline|positioning|valueprop|value_prop|headline/i.test(f.field),
  ];
  for (const match of byPriority) {
    const hit = facts.find(match);
    if (hit?.value) return hit.value.trim().slice(0, 120);
  }
  return undefined;
}

/**
 * The fact-first pipeline's Stage 1+2, run ONCE before the provider fan-out:
 *   1. Crawl the target URL and refine it (boilerplate stripped) → the ground-truth excerpt.
 *   2. Extract a source-attributed fact table from it with a SINGLE structured LLM call.
 * Both are handed to every provider via ResearchProviderInput. The business-identity providers
 * then reason from these facts in one call each instead of every one running its own web
 * search + LLM structuring — collapsing ~17 retrieval calls into this one shared extraction,
 * which is what cuts token use / free-tier throttling and raises grounding (every downstream
 * claim traces to a real page). Without this, providers derived the business identity from a
 * web search of an (often ambiguous) name and confabulated a different company entirely.
 *
 * Best-effort throughout: a crawl failure/timeout yields no excerpt and no facts, and providers
 * fall back to their prior search-only path — this is grounding, never a hard dependency.
 */
async function prefetchWebsite(url: string): Promise<WebsitePrefetch> {
  try {
    const timeout = new Promise<WebsitePrefetch>((resolve) => setTimeout(() => {
      logger.warn(`Website prefetch for ${url} exceeded ${WEBSITE_PREFETCH_TIMEOUT_MS}ms — proceeding without up-front facts (providers fall back to search grounding). Likely the crawl or the fact-extraction LLM call is throttled/slow.`);
      resolve({ facts: [] });
    }, WEBSITE_PREFETCH_TIMEOUT_MS));
    const crawl = (async (): Promise<WebsitePrefetch> => {
      // Use the DUAL crawl path (in-house scraper-service + crawl4ai, merged) rather than
      // crawl4ai alone: this up-front crawl is the single point of failure for the whole
      // fact-first pipeline, and crawl4ai degrades to 500s under concurrent load. Routing
      // through scrapeUrlWithFallback means a crawl4ai outage is transparently covered by the
      // in-house scraper (and vice-versa), so facts get extracted whenever EITHER crawler works.
      const { data } = await scrapeUrlWithFallback(url, ["markdown"]);
      const md = data?.markdown?.trim();
      if (!md) return { facts: [] };
      // relevanceFilter off: this is the business's OWN site, so keep all its real prose (only
      // strip nav/footer/cookie boilerplate) rather than filtering to a query's keywords.
      const refined = refineContent(md, "", { maxChars: WEBSITE_EXCERPT_MAX_CHARS, relevanceFilter: false });
      const excerpt = refined || undefined;
      // ONE fact-extraction call over the refined page — the single most valuable LLM call in
      // the whole run, since its output replaces ~17 per-provider retrieval calls downstream.
      const facts = excerpt ? await extractFactsFromPages([{ url, text: excerpt }]) : [];
      return { excerpt, facts };
    })();
    return await Promise.race([crawl, timeout]);
  } catch (err) {
    logger.warn(`Website prefetch/fact-extraction failed for ${url} — providers will fall back to search-only grounding`, err);
    return { facts: [] };
  }
}

/** Persistence + reporting hooks the orchestrator calls out to — real implementations
 * (defaultDeps below) hit Postgres via researchJobService; unit tests inject in-memory
 * fakes instead, so orchestration logic (parallel fan-out, retry, aggregation, state
 * transitions) is fully testable without a database. */
export interface OrchestratorDeps {
  loadJob(jobId: string): Promise<ResearchJobRecord | null>;
  markStatus(jobId: string, status: ResearchJobStatus, extra?: { startedAt?: boolean; completedAt?: boolean; error?: string }): Promise<void>;
  recordExecution(jobId: string, result: ProviderResult<unknown>): Promise<void>;
  persistSnapshot(jobId: string, context: ResearchContext): Promise<void>;
  persistCompleted(jobId: string, context: ResearchContext): Promise<void>;
  /** Resolves the Business record's real name for `ResearchProviderInput.businessName` —
   * optional so existing test fakes that don't provide it keep compiling; omission just
   * means every provider falls back to its current hostname-derived query, same as today. */
  loadBusinessName?(businessId: string): Promise<string | undefined>;
}

/** Never throws — a Business lookup failure (bad id, transient DB blip) degrades to
 * `undefined`, which every provider already treats as "derive a name from the hostname
 * instead", the same fail-soft contract every other provider-facing lookup in this file
 * follows (see recordExecution's `.catch` below). */
async function loadBusinessName(businessId: string): Promise<string | undefined> {
  try {
    const business = await getBusiness(businessId);
    return business?.name;
  } catch (err) {
    logger.warn(`Failed to load Business ${businessId} for research context — providers will fall back to hostname-derived name`, err);
    return undefined;
  }
}

export const defaultOrchestratorDeps: OrchestratorDeps = {
  loadJob: getResearchJob,
  markStatus: markResearchJobStatus,
  recordExecution: recordProviderExecution,
  persistSnapshot: createResearchSnapshot,
  persistCompleted: markResearchJobCompleted,
  loadBusinessName,
};

export interface RunResearchOrchestratorOptions {
  providers?: ResearchProvider<unknown>[];
  deps?: OrchestratorDeps;
  /** Called once per provider settlement (including retries) with (completedCount, totalCount,
   * providerName) — the worker wires this to BullMQ's job.updateProgress (the count) and to a
   * live-progress Redis record (the name), so the UI can show real step names as they complete
   * instead of a generic percentage. `providerName` is the just-settled provider's `name`, not a
   * cumulative list — callers accumulate it themselves (see workers/researchOrchestratorWorker.ts). */
  onProgress?: (completed: number, total: number, providerName?: string) => void | Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one provider to completion, retrying up to MAX_PROVIDER_ATTEMPTS times if it comes
 * back "failed" (a "partial" result is NOT retried — the provider ran successfully and
 * made a considered judgment call to report partial data, e.g. no OPENAI_API_KEY, and
 * retrying would just waste time reproducing the same partial result). Every attempt
 * (not just the last) is persisted via deps.recordExecution, so ProviderExecution's audit
 * trail shows exactly how many tries each provider needed. Independent of every other
 * provider's retry loop — a flaky provider retrying never blocks or delays the others,
 * since the orchestrator below fans all of these out concurrently.
 */
async function runProviderWithRetry(
  provider: ResearchProvider<unknown>,
  input: ResearchProviderInput,
  deps: OrchestratorDeps
): Promise<ProviderResult<unknown>> {
  let lastResult: ProviderResult<unknown> | undefined;

  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt++) {
    const startedAt = new Date().toISOString();
    let result: ProviderResult<unknown>;
    let timedOut = false;
    try {
      result = await withTimeout(provider.execute(input), PROVIDER_TIMEOUT_MS, `${provider.name} provider`);
      result = { ...result, attempt };
    } catch (err) {
      timedOut = err instanceof ProviderTimeoutError;
      result = {
        provider: provider.name,
        status: "failed",
        data: null,
        citations: [],
        evidence: [],
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
        attempt,
        error: err instanceof Error ? err.message : String(err),
        confidence: 0,
      };
    }

    lastResult = result;
    await deps.recordExecution(input.jobId, result).catch((err) => logger.warn(`Failed to persist ProviderExecution for ${provider.name}`, err));

    if (result.status !== "failed") return result;

    // A TIMEOUT is terminal, not transient. The provider consumed its entire PROVIDER_TIMEOUT_MS
    // budget; retrying spends the same budget again and, measured on prod, produced the identical
    // timeout every time — 19 of 19 for the `search` provider, which is what put a 301s
    // (150 + 1 + 150) floor under every research run no matter what site was being researched.
    // Real transient failures (a 5xx, a dropped socket, a throttle) still get their second attempt.
    if (timedOut) {
      logger.warn(
        `Provider ${provider.name} timed out after ${PROVIDER_TIMEOUT_MS}ms on attempt ${attempt} for job ${input.jobId} — not retrying ` +
          `(a retry would spend the same budget for the same result); this dimension degrades instead`
      );
      return result;
    }

    if (attempt < MAX_PROVIDER_ATTEMPTS) {
      logger.warn(`Provider ${provider.name} failed on attempt ${attempt}/${MAX_PROVIDER_ATTEMPTS} for job ${input.jobId} — retrying`, result.error);
      await sleep(PROVIDER_RETRY_DELAY_MS * attempt);
    }
  }

  return lastResult!;
}

/**
 * The Research Orchestrator's core entrypoint — called by the BullMQ worker (see
 * workers/researchOrchestratorWorker.ts) with just a jobId. Responsibilities per the
 * spec: create/track the job (createResearchJob in researchJobService.ts handles
 * creation; this handles tracking), execute all providers in parallel, retry failures,
 * aggregate results, persist research, and return the strongly-typed ResearchContext.
 */
export async function runResearchOrchestrator(jobId: string, options: RunResearchOrchestratorOptions = {}): Promise<ResearchContext> {
  const deps = options.deps ?? defaultOrchestratorDeps;
  const providers = options.providers ?? (createResearchProviders() as ResearchProvider<unknown>[]);

  const job = await deps.loadJob(jobId);
  if (!job) throw new Error(`Research job ${jobId} not found`);

  const state = new ResearchJobStateMachine(job.status);

  try {
    state.transition("running");
    await deps.markStatus(jobId, state.state, { startedAt: true });

    // Business name + the up-front crawl/fact-extraction run concurrently, so Stage 1+2 adds no
    // wall-clock over the name lookup it runs alongside. The extracted facts are the shared
    // grounding every business-identity provider reasons from (fact-first pipeline).
    const [businessName, prefetch] = await Promise.all([
      job.businessId ? deps.loadBusinessName?.(job.businessId) : Promise.resolve(undefined),
      prefetchWebsite(job.url),
    ]);
    if (prefetch.facts.length > 0) {
      logger.info(`Research job ${jobId}: extracted ${prefetch.facts.length} verified facts up-front — identity providers will reason from these instead of each searching`);
    }

    // Derive the business's industry/category from the verified facts so category-sensitive
    // providers (competitor discovery, audience, pricing) search with a REAL category instead of
    // falling back to the vague "its category" — which turned a niche B2B query into junk hits
    // (e.g. sports-score sites surfaced as "competitors" of an ERP/CRM company). Best-effort and
    // deterministic: pick the most descriptive product/category fact; undefined when none exist,
    // exactly as before (so no facts = same behavior as today, just no worse).
    const industry = deriveIndustry(prefetch.facts);
    if (industry) logger.info(`Research job ${jobId}: derived industry "${industry}" from verified facts — category-sensitive providers will use it`);

    const input: ResearchProviderInput = {
      jobId,
      workspaceId: job.workspaceId,
      businessId: job.businessId,
      url: job.url,
      businessName,
      industry,
      websiteExcerpt: prefetch.excerpt,
      verifiedFacts: prefetch.facts,
    };

    let completed = 0;
    const results = await Promise.all(
      providers.map(async (provider) => {
        const result = await runProviderWithRetry(provider, input, deps);
        completed += 1;
        await options.onProgress?.(completed, providers.length, provider.name);
        return result;
      })
    );

    state.transition("aggregating");
    await deps.markStatus(jobId, state.state);

    const context = aggregateResearch({
      jobId,
      workspaceId: job.workspaceId,
      businessId: job.businessId,
      url: job.url,
      results,
    });

    await deps.persistSnapshot(jobId, context);

    state.transition("completed");
    await deps.persistCompleted(jobId, context);

    return context;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Research orchestration failed";
    if (state.canTransitionTo("failed")) {
      state.transition("failed");
      await deps.markStatus(jobId, "failed", { completedAt: true, error: message }).catch((persistErr) => logger.error(`Failed to persist failure for job ${jobId}`, persistErr));
    }
    throw err;
  }
}
