import { logger } from "../modules/logger/logger.js";
import { withSpan } from "../infra/telemetry.js";
import { runDecisionEngine } from "../research/decision/decision-engine.js";
import type { DecisionContext } from "../research/decision/types.js";
import { runIntelligenceEnrichment, type IntelligenceEnrichmentResult } from "../research/intelligenceEnrichment.js";
import { runAgentCoordinator, type AgentCoordinatorOptions, type AgentPipelineResult } from "../agents/AgentCoordinator.js";
import type { ResearchContext } from "../research/types/index.js";

/**
 * The platform's unifying reasoning core — the one named entry point for "given research
 * on a business, think," rather than each caller re-deriving this same concurrency by
 * hand. Runs the Decision Engine, the 3-engine Intelligence Enrichment pass, and the
 * 20-agent Coordinator concurrently off one shared ResearchContext (same input,
 * independent outputs — none of the three depends on either of the others' results) and
 * returns them combined.
 *
 * This exact concurrency previously lived inline inside campaignGenerationPipeline.ts;
 * extracting it here doesn't change *when* anything runs relative to the rest of that
 * pipeline (fact extraction and CompanyKnowledgeBuilder still finish first, sequentially,
 * before think() is called — see that file's own comments on why) — it gives the platform
 * one reusable, independently-testable place to call for "think," so a second pipeline, a
 * chat-style assistant, or a debug tool that wants to re-run just the reasoning step
 * doesn't need to reconstruct this ordering itself.
 *
 * Deliberately excludes: crawl fact extraction and CompanyKnowledgeBuilder (must finish
 * BEFORE this runs, not concurrently with it), and everything Phase-3-shaped in campaign
 * generation (strategy/campaign building, recommendation persistence) — those consume
 * *this* function's output, they aren't part of the thinking itself. Onboarding's
 * deep-research path (modules/onboarding/analysis.ts) is intentionally NOT routed through
 * here — it's a fully separate, disjoint context shape (ProductAnalysis/AudienceAnalysis,
 * not ResearchContext); unifying it would mean redesigning that path's own data model, not
 * just wiring it through this function, so it stays out of scope for now.
 *
 * Failure posture mirrors what campaignGenerationPipeline.ts already did: the Decision
 * Engine and Intelligence Enrichment are "enhancement, not hard dependency" — a failure in
 * either degrades to null / an empty result and is logged, never thrown. The Agent
 * Coordinator is the one hard dependency (campaign generation cannot proceed without at
 * least the campaign-agent's result), so its failure propagates to the caller unchanged.
 */

export interface PlatformBrainDeps {
  runDecisionEngine: typeof runDecisionEngine;
  runIntelligenceEnrichment: typeof runIntelligenceEnrichment;
  runAgentCoordinator: typeof runAgentCoordinator;
}

export const defaultPlatformBrainDeps: PlatformBrainDeps = {
  runDecisionEngine,
  runIntelligenceEnrichment,
  runAgentCoordinator,
};

export interface PlatformBrainOptions {
  /**
   * Skip intelligence enrichment entirely. Set when the ResearchContext came from cache: the
   * engines derive per-business knowledge from that context and persist it, so a reused context
   * would recompute an identical result at full cost.
   */
  skipIntelligenceEnrichment?: boolean;
  /** Passed straight through to the Agent Coordinator — see AgentCoordinatorOptions.onProgress. */
  onAgentProgress?: AgentCoordinatorOptions["onProgress"];
  /** Injectable for tests, and for callers that need overridden behavior (mirrors every
   * other *Deps convention in this codebase, e.g. CampaignGenerationDeps) — defaults to
   * the real engines. */
  deps?: Partial<PlatformBrainDeps>;
  /** Included in this call's warn logs (e.g. "campaign generation job abc123") so a
   * Decision Engine/Intelligence Enrichment failure is traceable back to its caller without
   * every caller re-deriving its own log message. Omit for a generic message. */
  logLabel?: string;
}

export interface PlatformBrainResult {
  agents: AgentPipelineResult;
  /** Null when the Decision Engine failed — an enhancement, not a hard dependency; see
   * this module's doc comment. */
  decision: DecisionContext | null;
  intelligenceEnrichment: IntelligenceEnrichmentResult;
}

export async function think(context: ResearchContext, opts: PlatformBrainOptions = {}): Promise<PlatformBrainResult> {
  const deps: PlatformBrainDeps = { ...defaultPlatformBrainDeps, ...opts.deps };
  const label = opts.logLabel ? ` for ${opts.logLabel}` : "";

  return withSpan("platform_brain.think", async () => {
    // Fired (not awaited) before the Agent Coordinator below, exactly mirroring the
    // concurrency this had inline in campaignGenerationPipeline.ts — both are
    // "enhancement, not hard dependency," so a failure here degrades rather than throws.
    const decisionPromise = withSpan("platform_brain.decision", () => deps.runDecisionEngine(context)).catch((err) => {
      logger.warn(`PlatformBrain: Decision Engine failed${label} — continuing without it`, err);
      return null;
    });

    // Intelligence enrichment is the most expensive block whose output this pipeline barely reads:
    // it runs the audience/creative/pricing/market/landing-page engines (several LLM calls each) and
    // the campaign build consumes exactly ONE string from it (landingPage.recommendations[0]). Its
    // real value is the knowledge it persists into research memory — which is keyed to the SAME
    // ResearchContext. So when the context was reused from cache, re-running it re-derives
    // per-business knowledge that is already stored, at full token price.
    const intelligenceEnrichmentPromise = opts.skipIntelligenceEnrichment
      ? Promise.resolve<IntelligenceEnrichmentResult>({ landingPage: null }).then((empty) => {
          logger.info(`PlatformBrain: skipping intelligence enrichment${label} — research was reused, its knowledge is already persisted`);
          return empty;
        })
      : withSpan("platform_brain.intelligence_enrichment", () => deps.runIntelligenceEnrichment(context)).catch(
          (err): IntelligenceEnrichmentResult => {
            logger.warn(`PlatformBrain: Intelligence enrichment failed${label} — continuing without it`, err);
            return { landingPage: null };
          }
        );

    // The one hard dependency — its failure is NOT caught here, matching
    // campaignGenerationPipeline.ts's original behavior (campaign generation can't
    // proceed without at least the campaign-agent's result).
    const agents = await withSpan("platform_brain.agents", () =>
      deps.runAgentCoordinator(context, { onProgress: opts.onAgentProgress } satisfies AgentCoordinatorOptions)
    );

    const decision = await decisionPromise;
    const intelligenceEnrichment = await intelligenceEnrichmentPromise;

    return { agents, decision, intelligenceEnrichment };
  });
}
