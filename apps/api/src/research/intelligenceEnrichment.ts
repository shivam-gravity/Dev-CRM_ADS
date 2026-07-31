import { logger } from "../modules/logger/logger.js";
import { withLlmUsageContext } from "../infra/llmUsageContext.js";
import { runCreativeIntelligence } from "./creative-intelligence/CreativeIntelligenceEngine.js";
import { runPricingIntelligence } from "./pricing-intelligence/PricingIntelligenceEngine.js";
import { runLandingPageIntelligence, type LandingPageIntelligenceReport } from "./landing-page-intelligence/LandingPageIntelligenceEngine.js";
import type { ResearchContext } from "./types/index.js";

export interface IntelligenceEnrichmentResult {
  /** The Landing Page Intelligence report for context.url — returned (not just written to
   * Research Memory) so the Campaign Recommendation Engine can use its real
   * recommendations[0] instead of a fresh call to the same engine. Null when the fetch/
   * analysis failed (never blocks campaign generation either way). */
  landingPage: LandingPageIntelligenceReport | null;
}

/**
 * Runs the 3 Intelligence Engines that were built and tested but never invoked outside
 * their own test files — Creative, Pricing, and Landing-Page Intelligence
 * (research/{creative,pricing,landing-page}-intelligence/*.ts) — as a best-effort,
 * fire-and-forget enrichment pass after the research phase completes.
 *
 * Their primary value here isn't their return value (nothing currently reads it) — it's
 * the Research Memory entries they write as a side effect ("creative-analysis" and
 * "pricing-analysis" kinds). Before this, explainRecommendations
 * (research/decision/explainability.ts) queried those exact memory kinds for every
 * creative/messaging/offer recommendation and always got zero matches, because nothing
 * anywhere ever wrote to them — a permanently-dead lookup, not a rare miss. This makes
 * that lookup live: not necessarily for the run that triggered it (this is fire-and-forget,
 * racing the Decision Engine's own explainability pass), but for every subsequent run on
 * this or a similar business.
 *
 * Creative/Pricing Intelligence both require a competitor list as input (they analyze
 * competitors' creative/pricing, they don't discover competitors themselves) — sourced
 * from this same ResearchContext's own `competitors` field, so no extra research call is
 * needed to get it. Landing-Page Intelligence needs no competitor context and always runs.
 * Never throws: a failure here is explicitly not allowed to affect campaign generation,
 * which doesn't depend on any of this.
 */
export async function runIntelligenceEnrichment(context: ResearchContext): Promise<IntelligenceEnrichmentResult> {
  const competitors = (context.competitors?.competitors ?? []).map((c) => ({ name: c.name, url: c.url }));

  const base = { url: context.url, businessName: context.company?.name, workspaceId: context.workspaceId, businessId: context.businessId };

  // Each engine runs inside its own named usage context, so every LLM call it makes internally is
  // billed to that engine. The engines call llmClient's runStructured/runText, which carries no
  // task of its own — their spend used to land in the "unattributed" bucket (14.8% of a month's
  // tokens), which made it impossible to tell whether this whole best-effort enrichment pass was
  // worth what it costs. Nesting is what makes this work: the pipeline's { jobId } is already on
  // the context and is preserved, so each call now carries BOTH the job and the engine.
  const [landingPage] = await Promise.all([
    withLlmUsageContext({ task: "landing-page-intelligence" }, () => runLandingPageIntelligence(base)).catch((err) => {
      logger.warn(`Landing Page Intelligence enrichment failed for ${context.url} — continuing without it`, err);
      return null;
    }),
    competitors.length > 0
      ? withLlmUsageContext({ task: "creative-intelligence" }, () => runCreativeIntelligence({ ...base, competitors })).catch((err) => {
          logger.warn(`Creative Intelligence enrichment failed for ${context.url} — continuing without it`, err);
        })
      : Promise.resolve(),
    competitors.length > 0
      ? withLlmUsageContext({ task: "pricing-intelligence" }, () => runPricingIntelligence({ ...base, competitors })).catch((err) => {
          logger.warn(`Pricing Intelligence enrichment failed for ${context.url} — continuing without it`, err);
        })
      : Promise.resolve(),
  ]);

  return { landingPage };
}
