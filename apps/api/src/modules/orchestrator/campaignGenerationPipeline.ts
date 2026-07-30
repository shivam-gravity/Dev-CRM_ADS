import { logger } from "../logger/logger.js";
import type { AgentPipelineResult } from "../../agents/AgentCoordinator.js";
import { runAgentCoordinator } from "../../agents/AgentCoordinator.js";
import type { AgentResult, AudienceAgentOutput, BudgetAgentOutput, CampaignAgentOutput, ComplianceAgentOutput, CreativeAgentOutput, CriticAgentOutput, KeywordAgentOutput, ObjectionHandlingAgentOutput, PersonaAgentOutput, PricingOfferAgentOutput } from "../../agents/types/index.js";
import type { ResearchContext } from "../../research/types/index.js";
import { createResearchJob, findReusableResearch, runResearchOrchestrator, type RunResearchOrchestratorOptions } from "../../research/research-orchestrator/index.js";
import { extractAndPersistCrawlFacts } from "../../research/crawl/factExtraction.js";
import { buildAndPersistCompanyProfile } from "../../research/company-knowledge/CompanyKnowledgeBuilder.js";
import { runDecisionEngine } from "../../research/decision/decision-engine.js";
import type { DecisionContext } from "../../research/decision/types.js";
import { runIntelligenceEnrichment } from "../../research/intelligenceEnrichment.js";
import { generateAndPersistCampaignRecommendations } from "../../research/campaign-recommendation/CampaignRecommendationEngine.js";
import * as brain from "../../brain/PlatformBrain.js";
import { createStrategyFromAgentResults, getStrategy } from "../strategy/strategyEngine.js";
import { buildCampaignFromStrategy } from "./campaignOrchestrator.js";
import { getObjectiveLabel, isValidObjective } from "../adapters/metaObjectives.js";
import { getBusiness } from "../business/businessService.js";
import { vectorAdGenerationQueue, VECTOR_AD_GENERATION_QUEUE } from "../../infra/queue.js";
import { vectorAdJobDataFrom, type VectorAdGenerationJobData } from "../generation/vectorAdGenerationJob.js";
import { isVectorImageGenerationEnabled } from "../generation/vectorAdImageService.js";
import { recordRecommendationDecisions } from "../../research/decision/campaign-intelligence-store.js";
import { withQueuedLock } from "../../infra/distributedLock.js";
import { withLlmUsageContext } from "../../infra/llmUsageContext.js";
import { withSpan } from "../../infra/telemetry.js";
import {
  getCampaignGenerationJob,
  markCampaignGenerationCompleted,
  markCampaignGenerationStatus,
  persistAgentResults,
  persistDecisionContext,
  type CampaignGenerationJobRecord,
  type CampaignGenerationStatus,
} from "./campaignGenerationService.js";

/** Persistence hooks the pipeline calls out to — real implementations (defaultDeps
 * below) hit Postgres/the real orchestrators; unit tests inject in-memory fakes instead,
 * mirroring OrchestratorDeps in research/research-orchestrator/ResearchOrchestrator.ts. */
export interface CampaignGenerationDeps {
  loadJob: typeof getCampaignGenerationJob;
  markStatus: typeof markCampaignGenerationStatus;
  persistAgentResults: typeof persistAgentResults;
  persistDecisionContext: typeof persistDecisionContext;
  markCompleted: typeof markCampaignGenerationCompleted;
  createResearchJob: typeof createResearchJob;
  findReusableResearch: typeof findReusableResearch;
  runResearchOrchestrator: typeof runResearchOrchestrator;
  extractCrawlFacts: typeof extractAndPersistCrawlFacts;
  buildCompanyProfile: typeof buildAndPersistCompanyProfile;
  runDecisionEngine: typeof runDecisionEngine;
  runIntelligenceEnrichment: typeof runIntelligenceEnrichment;
  generateCampaignRecommendations: typeof generateAndPersistCampaignRecommendations;
  runAgentCoordinator: typeof runAgentCoordinator;
  createStrategyFromAgentResults: typeof createStrategyFromAgentResults;
  buildCampaignFromStrategy: typeof buildCampaignFromStrategy;
  getBusiness: typeof getBusiness;
  getStrategy: typeof getStrategy;
  vectorAdJobDataFrom: typeof vectorAdJobDataFrom;
  /** Whether to enqueue vector ad generation at all — injectable so tests don't depend on a live
   * Bedrock token (defaults to the real isVectorImageGenerationEnabled bearer-token check). */
  isVectorImageGenerationEnabled: typeof isVectorImageGenerationEnabled;
  /** Enqueue the vector-ad-generation job; overridable so tests assert enqueue without a live queue. */
  enqueueVectorAdGeneration: (data: VectorAdGenerationJobData) => Promise<unknown>;
  withLock: typeof withQueuedLock;
}

export const defaultCampaignGenerationDeps: CampaignGenerationDeps = {
  loadJob: getCampaignGenerationJob,
  markStatus: markCampaignGenerationStatus,
  persistAgentResults,
  persistDecisionContext,
  markCompleted: markCampaignGenerationCompleted,
  createResearchJob,
  findReusableResearch,
  runResearchOrchestrator,
  extractCrawlFacts: extractAndPersistCrawlFacts,
  buildCompanyProfile: buildAndPersistCompanyProfile,
  runDecisionEngine,
  runIntelligenceEnrichment,
  generateCampaignRecommendations: generateAndPersistCampaignRecommendations,
  runAgentCoordinator,
  createStrategyFromAgentResults,
  buildCampaignFromStrategy,
  getBusiness,
  getStrategy,
  vectorAdJobDataFrom,
  isVectorImageGenerationEnabled,
  enqueueVectorAdGeneration: (data) => vectorAdGenerationQueue.add(VECTOR_AD_GENERATION_QUEUE, data),
  withLock: withQueuedLock,
};

// Generous relative to the ~1 minute a full research+agents+build run has taken in live
// verification, so a slow-but-healthy run is never preempted by its own lock expiring —
// the cost of erring long here is a genuinely-crashed job leaving the lock stuck for up
// to this long, which is an acceptable trade since a stuck lock only blocks re-running
// the SAME business, not the whole pipeline.
const CAMPAIGN_GENERATION_LOCK_TTL_MS = 10 * 60 * 1000;

// A completed ResearchJob for the same (workspace, business, url) within this window is
// reused instead of re-running Phase 1 (the URL deep-research cache). Only the research INPUT
// is cached — the campaign, its budget, and its name are always built fresh from the reused
// ResearchContext in Phases 2-3. Code default 6 HOURS, but PRODUCTION NOW SETS 3 DAYS via
// docker-compose (CAMPAIGN_RESEARCH_CACHE_TTL_MS): measured, only 3 of 10 stored runs were ever
// reusable, and a 6h window threw away even GOOD research (0.68) — a company's site does not change
// every six hours, so the pipeline was paying the full 27-provider research bill again and again.
// A cached run older than this is a cache miss
// and gets re-researched fresh, so served deep-research is never more than 6h old (per the
// "clear the cache every 6 hrs" policy). env-tunable via CAMPAIGN_RESEARCH_CACHE_TTL_MS. Kept
// well under the UI's 14-day staleness horizon (CAMPAIGN_RESEARCH_FRESHNESS_TTL_MS, router.ts)
// so we never serve research the UI would already badge as stale. A non-finite/negative env
// value falls back to the 6-hour default rather than poisoning the lookup with an Invalid Date.
const parsedResearchCacheTtl = Number(process.env.CAMPAIGN_RESEARCH_CACHE_TTL_MS);
export const CAMPAIGN_RESEARCH_CACHE_TTL_MS =
  Number.isFinite(parsedResearchCacheTtl) && parsedResearchCacheTtl >= 0
    ? parsedResearchCacheTtl
    : 6 * 60 * 60 * 1000;

// Cache quality-gate threshold (0-1): a cached ResearchContext whose overallConfidence is below
// this — OR whose company identity anchor is null — is treated as a cache MISS and re-researched
// rather than re-served (findReusableResearch / isReusableContext). Guards against re-serving a
// run degraded by a provider-timeout storm: the 07-16 polluxa.com run scored 0.34 with a null
// company and was confabulated as "medical device", then re-served on two later cache hits.
//
// Code default 0.65; PRODUCTION NOW SETS 0.55 via docker-compose. On a 2-core box confidence is
// CPU-bound (crawl4ai timeouts), so the same URL scores 0.68 when the crawl completes and 0.28-0.45
// when it does not — 0.65 disqualified runs that were merely slow, not wrong, making them pay twice.
// Only research at/above this confidence is trusted enough to reuse — anything
// less is re-researched fresh every time, so a mediocre/incorrect run can never be served twice.
// Set to 0.65 (down from 0.75) now that the fact-first pipeline reliably lands ~0.78-0.81 on a
// clean run: 0.65 keeps genuinely-good runs cacheable (fast repeat launches) while still rejecting
// the degraded ~0.3-0.5 runs that produced confabulated/placeholder data. Read gate here; the
// serve side (findReusableResearch → isReusableContext) enforces the same threshold, so
// sub-threshold data is never eligible for reuse. A non-finite/out-of-range env value falls back
// to 0.65. The company-null check is a hard invariant, not gated by this.
const parsedResearchMinConfidence = Number(process.env.CAMPAIGN_RESEARCH_MIN_CONFIDENCE);
export const CAMPAIGN_RESEARCH_MIN_CONFIDENCE =
  Number.isFinite(parsedResearchMinConfidence) && parsedResearchMinConfidence >= 0 && parsedResearchMinConfidence <= 1
    ? parsedResearchMinConfidence
    : 0.65;

export interface RunCampaignGenerationOptions {
  deps?: CampaignGenerationDeps;
  /** When true, skip the research cache and always run fresh Phase-1 research. Sourced from
   * the POST /campaigns/generate body flag, carried on the BullMQ payload (no DB column). */
  forceRefresh?: boolean;
  /** User-chosen Meta campaign objective (e.g. OUTCOME_LEADS) from the generation request.
   * Carried on the BullMQ payload (no DB column, same pattern as forceRefresh) and stamped onto
   * the built Campaign so launchMetaHierarchy uses it instead of the hardcoded default. */
  objective?: string;
  /** Called with (completed, total, stepName) across the WHOLE pipeline (research providers +
   * agents + the campaign-build step) on one consistent 0..total scale, so a single
   * BullMQ job.updateProgress call can represent the entire Gateway -> Campaign Route ->
   * Research Orchestrator -> Knowledge Aggregator -> AI Agent Coordinator -> Campaign
   * Builder flow, not just one stage of it. `stepName` is the provider/agent that just
   * settled (or a phase-boundary marker like "aggregating"/"campaign-built") — callers use
   * it to show real live progress instead of a bare percentage. */
  onProgress?: (completed: number, total: number, stepName?: string) => void | Promise<void>;
}

// Fixed fan-out widths of the two sub-pipelines this orchestrates — see
// research/providers/index.ts (27 providers) and agents/agents/index.ts (20 agents) —
// plus one unit for the campaign-build step, so progress is one meaningful number
// across all three phases rather than three separately-scaled ones.
const RESEARCH_PROVIDER_COUNT = 27;
const AGENT_COUNT = 20;
// Exported so the gateway's progress route (router.ts) can report a total alongside the
// live step list without duplicating this arithmetic.
export const TOTAL_PIPELINE_UNITS = RESEARCH_PROVIDER_COUNT + AGENT_COUNT + 1;

/**
 * Human-meaningful, self-disambiguating campaign name.
 *
 * The old version returned the bare brand name, so EVERY generated campaign for a business got
 * the exact same name — a campaigns list of six identical rows with no way to tell them apart
 * (and the same opaque name inside Meta Ads Manager, where it has to be recognizable months
 * later). Objective + date makes each run identifiable at a glance and sorts sensibly.
 *
 * An explicit `job.name` from the request still wins — but only if it isn't blank, since an empty
 * string is not a name and `??` would have accepted one.
 */
function defaultCampaignName(
  job: CampaignGenerationJobRecord,
  business: { name: string; brandName?: string } | null,
  objective?: string
): string {
  const requested = job.name?.trim();
  if (requested) return requested;

  const brand = business?.brandName?.trim() || business?.name?.trim() || hostLabelFromUrl(job.url);
  const objectiveLabel = objective && isValidObjective(objective) ? getObjectiveLabel(objective) : "Campaign";
  // Date only (no clock time): two runs on the same day are rare, and a timestamp makes the name
  // noisy in Ads Manager. Meta permits duplicate names, so collisions are harmless if they happen.
  const day = new Date().toISOString().slice(0, 10);
  return `${brand} · ${objectiveLabel} · ${day}`;
}

/** "polluxa.com" / "https://polluxa.com/x" -> "Polluxa" — last-resort brand when the business row has no name. */
function hostLabelFromUrl(url: string): string {
  const host = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0] ?? url;
  const root = host.split(".")[0] ?? host;
  return root ? root.charAt(0).toUpperCase() + root.slice(1) : "Campaign";
}

/**
 * The full agent-pipeline's core entrypoint — called by the BullMQ worker (see
 * workers/campaignGenerationWorker.ts) with just a jobId, exactly like
 * runResearchOrchestrator. Sequences, in order: Research Orchestrator (which runs its
 * own 27 providers + Knowledge Aggregator internally), the AI Agent Coordinator (20
 * agents), then the Campaign Builder (AdStrategy -> Campaign via the existing,
 * unmodified buildCampaignFromStrategy). No agent, provider, or prompt is touched here —
 * this file only sequences already-built, independently-tested pieces.
 */
export async function runCampaignGenerationPipeline(
  jobId: string,
  options: RunCampaignGenerationOptions = {}
): Promise<{ campaignId: string; strategyId: string; researchJobId: string }> {
  const deps = options.deps ?? defaultCampaignGenerationDeps;

  const job = await deps.loadJob(jobId);
  if (!job) throw new Error(`Campaign generation job ${jobId} not found`);

  let completedUnits = 0;
  const reportOverall = async (stepName?: string) => {
    await options.onProgress?.(completedUnits, TOTAL_PIPELINE_UNITS, stepName);
  };

  const markStatus = async (status: CampaignGenerationStatus, extra?: Parameters<typeof markCampaignGenerationStatus>[2]) => {
    await deps.markStatus(jobId, status, extra);
  };

  try {
    // One attribution scope for the ENTIRE run: research providers, the decision engine, the
    // intelligence engines, the agents and vector-image generation all inherit it, so every token
    // they spend is billed to this job without any of them knowing about accounting.
    return await withLlmUsageContext({ jobId }, () =>
      deps.withLock(`campaign-generation:${job.businessId}`, CAMPAIGN_GENERATION_LOCK_TTL_MS, CAMPAIGN_GENERATION_LOCK_TTL_MS, () => runPhases(job))
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Campaign generation failed";
    await deps
      .markStatus(jobId, "failed", { completedAt: true, error: message })
      .catch((persistErr) => logger.error(`Failed to persist failure for campaign generation job ${jobId}`, persistErr));
    throw err;
  }

  // ── Phases 1-3, run only while campaign-generation:${job.businessId} is held — a
  // second concurrent generate request for the same business rejects immediately (via
  // deps.withLock throwing LockAlreadyHeldError) instead of racing this one. `job` is
  // passed explicitly (not closed over) so TypeScript's null-narrowing above still
  // applies inside this nested function. ──
  async function runPhases(job: CampaignGenerationJobRecord): Promise<{ campaignId: string; strategyId: string; researchJobId: string }> {
    // ── Phase 1: Research Orchestrator -> Knowledge Aggregator ──
    // Try to reuse recent completed research for this exact (workspace, business, url) instead
    // of paying for Phase 1 again. forceRefresh bypasses the lookup entirely.
    const cachedResearch = options.forceRefresh
      ? null
      : await deps.findReusableResearch(job.workspaceId, job.businessId, job.url, CAMPAIGN_RESEARCH_CACHE_TTL_MS, CAMPAIGN_RESEARCH_MIN_CONFIDENCE);

    // Defense-in-depth: never trust the keyed lookup alone. If the reloaded context's OWN
    // identity doesn't match this job, treat it as a miss and run fresh — a mismatch here means
    // a keying/poisoning bug, so log it loudly as a tripwire (this is the exact class of bug the
    // competitor-memory poisoning fix guarded against: wrong-business data served confidently).
    const reusable =
      cachedResearch && cachedResearch.context.businessId === job.businessId && cachedResearch.context.url === job.url
        ? cachedResearch
        : null;
    if (cachedResearch && !reusable) {
      logger.warn(
        `Research cache candidate ${cachedResearch.researchJobId} rejected for campaign generation job ${jobId}: ` +
          `reloaded context identity (businessId=${cachedResearch.context.businessId ?? "none"}, url=${cachedResearch.context.url}) ` +
          `does not match job (businessId=${job.businessId}, url=${job.url}) — running fresh research`
      );
    }

    let researchJobId: string;
    let context: ResearchContext;
    if (reusable) {
      researchJobId = reusable.researchJobId;
      context = reusable.context;
      await markStatus("researching", { startedAt: true, researchJobId });
      logger.info(
        `Campaign generation job ${jobId} reused research job ${researchJobId} (cache hit, TTL ${CAMPAIGN_RESEARCH_CACHE_TTL_MS}ms) — skipping the 27-provider research phase`
      );
      completedUnits = RESEARCH_PROVIDER_COUNT;
      await reportOverall("research-cache-hit");
    } else {
      const researchJob = await deps.createResearchJob(job.workspaceId, job.url, job.businessId);
      researchJobId = researchJob.id;
      await markStatus("researching", { startedAt: true, researchJobId });

      context = await withSpan("campaign_generation.research", () =>
        deps.runResearchOrchestrator(researchJob.id, {
          onProgress: async (completed, _total, providerName) => {
            completedUnits = completed;
            await reportOverall(providerName);
          },
        })
      );
      completedUnits = RESEARCH_PROVIDER_COUNT;
    }
    await markStatus("aggregating");
    await reportOverall("aggregating");

    // Fact extraction must finish BEFORE the agents run (unlike the Decision Engine below,
    // which is concurrent) — the fact-grounded agents (creative/campaign/critic) read
    // CrawlFact rows from the DB at execute time, so facts written after they start are
    // invisible to them. Still best-effort: no crawl persistence or an extraction failure
    // just means agents run un-grounded, exactly as they did before this step existed.
    //
    // On a cache HIT we deliberately SKIP extraction: loadVerifiedFacts() (agents/crawlFacts.ts)
    // reads CrawlFact by context.website.crawlJobId, and the rows written during the ORIGINAL
    // run are keyed by that same id and still persist in the DB — so the agents read identical
    // facts. Re-running would be wrong, not just wasteful: persistCrawlFacts is a blind
    // createMany with fresh UUIDs (no upsert/dedupe — crawlPersistence.ts), so a second pass
    // DOUBLES every fact row, skewing the agents' top-40-by-confidence selection while paying
    // for the very fact-extraction LLM call the cache exists to avoid.
    const crawlJobId = context.website?.crawlJobId;
    if (crawlJobId && !reusable) {
      await withSpan("campaign_generation.fact_extraction", () => deps.extractCrawlFacts(crawlJobId))
        .then((count) => logger.info(`Extracted ${count} crawl facts for campaign generation job ${jobId}`))
        .catch((err) => logger.warn(`Crawl fact extraction failed for campaign generation job ${jobId} — agents run without verified facts`, err));
    }

    // Company Knowledge Builder — pure assembly from the ResearchContext/CrawlFact rows
    // already produced above, no new external calls, so it's cheap enough to await inline
    // rather than run fire-and-forget. Best-effort: never fails campaign generation (the
    // function itself never throws, but this stays defensive in case that contract changes).
    await withSpan("campaign_generation.company_knowledge", () => deps.buildCompanyProfile(context)).catch((err) => {
      logger.warn(`Company Knowledge Builder failed for campaign generation job ${jobId} — continuing without a persisted CompanyProfile`, err);
    });

    // ── Phase 2: PlatformBrain — Decision Engine + Intelligence Enrichment + Agent
    // Coordinator, concurrently off this same ResearchContext (same input, independent
    // outputs, so none of the three adds extra latency to the others). This exact
    // concurrency used to be inlined here; see brain/PlatformBrain.ts for the full
    // rationale for pulling it into one named, reusable entry point. ──
    await markStatus("running_agents");
    const brainResult = await withSpan("campaign_generation.think", () =>
      brain.think(context, {
        logLabel: `campaign generation job ${jobId}`,
        // A reused context yields identical enrichment, already persisted by the run that produced
        // it — so this skips several LLM calls per warm generation for no loss of information.
        skipIntelligenceEnrichment: Boolean(reusable),
        onAgentProgress: async (completed, _total, agentName) => {
          completedUnits = RESEARCH_PROVIDER_COUNT + completed;
          await reportOverall(agentName);
        },
        deps: {
          runDecisionEngine: deps.runDecisionEngine,
          runIntelligenceEnrichment: deps.runIntelligenceEnrichment,
          runAgentCoordinator: deps.runAgentCoordinator,
        },
      })
    );
    const pipeline: AgentPipelineResult = brainResult.agents;
    await deps.persistAgentResults(jobId, pipeline.results);

    // Persisted as soon as it's ready — brain.think() already ran and awaited this
    // concurrently with the agents above, so there's no extra latency to wait out here.
    const decisionContext: DecisionContext | null = brainResult.decision;
    if (decisionContext) await deps.persistDecisionContext(jobId, decisionContext);

    const campaignAgentResult = pipeline.results["campaign-agent"] as AgentResult<CampaignAgentOutput> | undefined;
    if (!campaignAgentResult) throw new Error("campaign-agent did not produce a result — cannot build a campaign");

    // These five previously ran alongside the other producer agents, got persisted via
    // persistAgentResults above, and were never read again — folding their output into the
    // strategy (extra creatives, headline/primary-text variants, a compliance warning, an
    // advisory quality warning) is what actually puts them to work.
    const pricingOfferResult = pipeline.results["pricing-offer-agent"] as AgentResult<PricingOfferAgentOutput> | undefined;
    const objectionHandlingResult = pipeline.results["objection-handling-agent"] as AgentResult<ObjectionHandlingAgentOutput> | undefined;
    const complianceResult = pipeline.results["compliance-agent"] as AgentResult<ComplianceAgentOutput> | undefined;
    const creativeResult = pipeline.results["creative-agent"] as AgentResult<CreativeAgentOutput> | undefined;
    const criticResult = pipeline.results["critic-agent"] as AgentResult<CriticAgentOutput> | undefined;
    const keywordResult = pipeline.results["keyword-agent"] as AgentResult<KeywordAgentOutput> | undefined;
    const audienceResult = pipeline.results["audience-agent"] as AgentResult<AudienceAgentOutput> | undefined;
    // persona-agent was merged into audience-agent: prefer a real persona-agent result if one ran
    // (full 20-agent mode), else derive the persona output from the audience-agent's own personas
    // (the essential 7-agent mode). Downstream (strategyEngine) only reads persona.personas.
    const personaAgentResult = pipeline.results["persona-agent"] as AgentResult<PersonaAgentOutput> | undefined;
    const personaResult: AgentResult<PersonaAgentOutput> | undefined =
      personaAgentResult ??
      (audienceResult && audienceResult.data.personas?.length
        ? { ...audienceResult, data: { personas: audienceResult.data.personas } }
        : undefined);

    // ── Phase 3: Campaign Builder ──
    await markStatus("building_campaign");
    const { campaign, strategyId } = await withSpan("campaign_generation.build", async () => {
      const business = await deps.getBusiness(job.businessId);
      const strategy = await deps.createStrategyFromAgentResults(job.businessId, campaignAgentResult.data, decisionContext, {
        pricingOffer: pricingOfferResult?.data,
        objectionHandling: objectionHandlingResult?.data,
        compliance: complianceResult?.data,
        creative: creativeResult?.data,
        critic: criticResult?.data,
        keyword: keywordResult?.data,
        persona: personaResult?.data,
        audience: audienceResult?.data,
        // Knowledge Fusion conflicts — a high-severity identity-vertical-mismatch attaches an
        // advisory qualityWarning + downgrades the strategy score (Fix #3, Option C).
        identityConflicts: context.metadata?.fusion?.conflicts ?? null,
      });
      await markStatus("building_campaign", { strategyId: strategy.id });

      const budgetAgentResult = pipeline.results["budget-agent"] as AgentResult<BudgetAgentOutput> | undefined;
      const dailyBudgetCents = job.dailyBudgetCents ?? budgetAgentResult?.data.recommendedDailyBudgetCents ?? 2000;
      const name = defaultCampaignName(job, business, options.objective);

      const campaign = await deps.buildCampaignFromStrategy(strategy.id, name, dailyBudgetCents, options.objective);
      return { campaign, strategyId: strategy.id };
    });

    // Campaign Recommendation Engine — additive alongside the single Campaign just built
    // above (never replacing it). Best-effort: the function itself never throws, but this
    // stays defensive in case that contract changes.
    const { landingPage } = brainResult.intelligenceEnrichment;
    const landingPageRecommendation = landingPage?.recommendations[0] ?? "No landing-page-specific recommendation available.";
    await withSpan("campaign_generation.campaign_recommendations", () =>
      deps.generateCampaignRecommendations(jobId, decisionContext, campaignAgentResult.data.creatives, landingPageRecommendation)
    ).catch((err) => {
      logger.warn(`Campaign Recommendation Engine failed for campaign generation job ${jobId} — continuing without persisted recommendations`, err);
    });

    completedUnits = TOTAL_PIPELINE_UNITS;
    await reportOverall("campaign-built");
    await deps.markCompleted(jobId, campaign.id);

    // Vector ad images — enqueued best-effort onto its OWN queue so the campaign returns now and the
    // grounded SVG creative set is generated asynchronously (via Claude/Bedrock) and attached to the
    // campaign's creativeAssets. Never blocks or fails campaign generation: enqueue errors are logged
    // and swallowed, and the whole step is skipped when Bedrock isn't configured (no bearer token).
    if (deps.isVectorImageGenerationEnabled()) {
      const strategyForImages = await deps.getStrategy(strategyId).catch(() => null);
      await deps
        .enqueueVectorAdGeneration(
          deps.vectorAdJobDataFrom({
            workspaceId: job.workspaceId,
            businessId: job.businessId,
            campaignId: campaign.id,
            strategyId,
            research: context,
            strategy: { summary: strategyForImages?.summary, creatives: strategyForImages?.creatives ?? campaignAgentResult.data.creatives },
            // Generate for the ads that actually need an image instead of a blind 4. Each image is
            // an 8192-maxTokens call plus its thinking allowance — the largest output block in the
            // pipeline — and a single-ad campaign was paying for four, three of which went unused.
            count: campaign.variants.filter((v) => !v.creative?.imageUrl && !v.creative?.videoUrl).length,
          })
        )
        .catch((err) => logger.warn(`Failed to enqueue vector ad generation for campaign ${campaign.id} — campaign is unaffected`, err));
    }

    // Campaign Intelligence: records which of the Decision Engine's ranked recommendations
    // actually fed this campaign vs. which were ranked but not used — best-effort, same
    // "enhancement, not hard dependency" posture as the Decision Engine call itself above.
    if (decisionContext) {
      await recordRecommendationDecisions({
        workspaceId: job.workspaceId,
        businessId: job.businessId,
        campaignId: campaign.id,
        decisionContext,
      }).catch((err) => {
        logger.warn(`recordRecommendationDecisions failed for campaign generation job ${jobId} — continuing`, err);
      });
    }

    return { campaignId: campaign.id, strategyId, researchJobId };
  }
}
