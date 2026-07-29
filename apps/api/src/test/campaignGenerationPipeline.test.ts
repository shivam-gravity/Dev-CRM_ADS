import { test, after } from "node:test";
import assert from "node:assert";
import { runCampaignGenerationPipeline, CAMPAIGN_RESEARCH_CACHE_TTL_MS, type CampaignGenerationDeps } from "../modules/orchestrator/campaignGenerationPipeline.js";
import { disconnectTestInfra } from "./testUtils/disconnectInfra.js";
import { LockWaitTimeoutError } from "../infra/distributedLock.js";
import { logger } from "../modules/logger/logger.js";
import type { CampaignGenerationJobRecord, CampaignGenerationStatus } from "../modules/orchestrator/campaignGenerationService.js";
import type { ResearchJobRecord } from "../research/research-orchestrator/researchJobService.js";
import type { ResearchContext } from "../research/types/index.js";
import type { AgentPipelineResult } from "../agents/AgentCoordinator.js";
import type { AgentResult, BudgetAgentOutput, CampaignAgentOutput } from "../agents/types/index.js";
import type { AdStrategy, BusinessProfile, Campaign } from "../types/index.js";
import type { DecisionContext } from "../research/decision/types.js";

// The pipeline now transitively imports infra/queue.js (its default deps reference the
// vector-ad-generation queue), which eagerly opens Redis connections at module load — so this
// file must close them or `node --test` hangs after the last test. See disconnectInfra.ts.
after(disconnectTestInfra);

function fakeGenerationJob(overrides: Partial<CampaignGenerationJobRecord> = {}): CampaignGenerationJobRecord {
  const now = new Date().toISOString();
  return {
    id: "gen-1", workspaceId: "ws-1", businessId: "biz-1", url: "https://example.com",
    status: "pending", agentResults: null, decisionContext: null, createdAt: now, updatedAt: now, ...overrides,
  };
}

function fakeDecisionContext(): DecisionContext {
  return {
    businessSummary: "A test business.", audiencePersonas: [], topOpportunities: [], topRisks: [],
    pricingTiers: [], notableCustomers: [], quantifiedProofPoints: [], regionalMarketDepth: null,
    recommendedPositioning: "n/a", recommendedAudiencePriority: "n/a", recommendedChannels: [],
    recommendedBudgetAllocation: {}, recommendedDailyBudgetCents: 0, budgetReasoning: [],
    recommendedCreativeDirection: "n/a", recommendedOffer: "n/a",
    recommendedMessaging: "n/a",
    swot: { strengths: [], weaknesses: [], opportunities: [], threats: [] }, marketGaps: [], funnelStrategy: "n/a", mediaStrategy: "n/a",
    confidence: 0.5, evidence: [], tradeoffs: [],
    recommendations: [], tradeoffAnalyses: [], explainability: [], strategies: [], simulations: [],
    generatedAt: "now",
  };
}

function fakeResearchContext(): ResearchContext {
  return {
    jobId: "research-1", workspaceId: "ws-1", url: "https://example.com",
    website: null, market: null, technology: null, competitors: null, keywords: null, audience: null, company: null, news: null,
    metadata: { jobId: "research-1", generatedAt: "now", totalDurationMs: 0, providersSucceeded: [], providersPartial: [], providersFailed: [], confidenceByProvider: {}, overallConfidence: 0 },
  };
}

function fakeCampaignAgentResult(): AgentResult<CampaignAgentOutput> {
  return {
    agent: "campaign-agent", promptId: "campaign-agent", promptVersion: 1,
    data: { summary: "A strategy", recommendedNetworks: ["meta"], budgetSplit: { meta: 1 }, audiences: ["Everyone"], creatives: [{ headline: "Hi", body: "Body", callToAction: "Go" }] },
    confidence: 0.9, evidence: [], usedFallback: false, generatedAt: "now", durationMs: 1,
  };
}

function fakeBudgetAgentResult(dailyBudgetCents: number): AgentResult<BudgetAgentOutput> {
  return {
    agent: "budget-agent", promptId: "budget-agent", promptVersion: 1,
    data: { recommendedDailyBudgetCents: dailyBudgetCents, reasoning: ["because"] } as BudgetAgentOutput,
    confidence: 0.9, evidence: [], usedFallback: false, generatedAt: "now", durationMs: 1,
  };
}

interface FakeDeps extends CampaignGenerationDeps {
  statusHistory: CampaignGenerationStatus[];
  persistedAgentResults: Record<string, AgentResult<unknown>> | null;
  persistedDecisionContext: DecisionContext | null;
  enqueuedVectorAdJobs: unknown[];
}

/** Builds a fully injectable CampaignGenerationDeps so the pipeline's sequencing logic
 * (research -> aggregate -> agents -> strategy -> campaign build -> persist) is testable
 * without Postgres/Redis/OpenAI — mirrors researchOrchestrator.test.ts's fakeDeps. */
function fakeDeps(opts: {
  job: CampaignGenerationJobRecord;
  agentResults?: Record<string, AgentResult<unknown>>;
  business?: BusinessProfile | null;
}): FakeDeps {
  const statusHistory: CampaignGenerationStatus[] = [];
  const enqueuedVectorAdJobs: unknown[] = [];
  let persistedAgentResults: Record<string, AgentResult<unknown>> | null = null;
  let persistedDecisionContext: DecisionContext | null = null;
  const agentResults = opts.agentResults ?? { "campaign-agent": fakeCampaignAgentResult(), "budget-agent": fakeBudgetAgentResult(5000) };

  const researchJobRecord: ResearchJobRecord = {
    id: "research-1", workspaceId: opts.job.workspaceId, businessId: opts.job.businessId, url: opts.job.url,
    status: "pending", context: null, createdAt: "now", updatedAt: "now",
  };

  const strategy: AdStrategy = {
    id: "strategy-1", businessId: opts.job.businessId, summary: "A strategy",
    recommendedNetworks: ["meta"], budgetSplit: { meta: 1 }, audiences: ["Everyone"],
    creatives: [{ headline: "Hi", body: "Body", callToAction: "Go" }], createdAt: "now",
  };

  const campaign: Campaign = {
    id: "campaign-1", businessId: opts.job.businessId, strategyId: strategy.id, name: "Test Campaign",
    status: "draft", networks: ["meta"], dailyBudgetCents: 5000, variants: [], createdAt: "now", updatedAt: "now",
  };

  return {
    statusHistory,
    enqueuedVectorAdJobs,
    get persistedAgentResults() { return persistedAgentResults; },
    get persistedDecisionContext() { return persistedDecisionContext; },
    async loadJob() { return opts.job; },
    async markStatus(_id, status) { statusHistory.push(status); },
    async persistAgentResults(_id, results) { persistedAgentResults = results; },
    async persistDecisionContext(_id, decisionContext) { persistedDecisionContext = decisionContext; },
    async markCompleted() {},
    async createResearchJob() { return researchJobRecord; },
    async findReusableResearch() { return null; }, // default: cache miss → existing tests keep the fresh path
    async runResearchOrchestrator(_jobId, options) {
      await options?.onProgress?.(9, 9);
      return fakeResearchContext();
    },
    async extractCrawlFacts() { return 0; },
    async buildCompanyProfile() { return null; },
    async runDecisionEngine() { return fakeDecisionContext(); },
    async runIntelligenceEnrichment() { return { landingPage: null }; },
    async generateCampaignRecommendations() { return 0; },
    async runAgentCoordinator(_context, options): Promise<AgentPipelineResult> {
      await options?.onProgress?.(10, 10);
      return { results: agentResults, order: Object.keys(agentResults) };
    },
    async createStrategyFromAgentResults() { return strategy; },
    async buildCampaignFromStrategy() { return campaign; },
    async getBusiness() { return opts.business ?? null; },
    async getStrategy() { return strategy; },
    vectorAdJobDataFrom(input) {
      return { workspaceId: input.workspaceId, businessId: input.businessId, campaignId: input.campaignId, strategyId: input.strategyId, context: { brand: "Test" } };
    },
    isVectorImageGenerationEnabled() { return true; },
    async enqueueVectorAdGeneration(data) { enqueuedVectorAdJobs.push(data); return undefined; },
    async withLock(_key, _ttlMs, _maxWaitMs, fn) { return fn(); },
  } as FakeDeps;
}

test("campaignGenerationPipeline - runs research -> agents -> strategy -> campaign build in order and persists results", async () => {
  const job = fakeGenerationJob();
  const deps = fakeDeps({ job });

  const progressCalls: Array<[number, number]> = [];
  const result = await runCampaignGenerationPipeline(job.id, { deps, onProgress: async (c, t) => { progressCalls.push([c, t]); } });

  assert.deepStrictEqual(result, { campaignId: "campaign-1", strategyId: "strategy-1", researchJobId: "research-1" });
  assert.deepStrictEqual(deps.statusHistory, ["researching", "aggregating", "running_agents", "building_campaign", "building_campaign"]);
  assert.ok(deps.persistedAgentResults && "campaign-agent" in deps.persistedAgentResults, "agent results must be persisted before the campaign is built");
  // 27 research units + 20 agent units + 1 build unit = 48 total; final call must reach it.
  assert.deepStrictEqual(progressCalls[progressCalls.length - 1], [48, 48]);
});

test("campaignGenerationPipeline - enqueues vector ad generation for the built campaign when enabled", async () => {
  const job = fakeGenerationJob();
  const deps = fakeDeps({ job });

  await runCampaignGenerationPipeline(job.id, { deps });

  assert.strictEqual(deps.enqueuedVectorAdJobs.length, 1, "one vector ad generation job must be enqueued");
  assert.strictEqual((deps.enqueuedVectorAdJobs[0] as { campaignId: string }).campaignId, "campaign-1");
});

test("campaignGenerationPipeline - does NOT enqueue vector ad generation when disabled (no Gemini token)", async () => {
  const job = fakeGenerationJob();
  const deps = fakeDeps({ job });
  deps.isVectorImageGenerationEnabled = () => false;

  await runCampaignGenerationPipeline(job.id, { deps });

  assert.strictEqual(deps.enqueuedVectorAdJobs.length, 0, "no job when vector generation is disabled");
});

test("campaignGenerationPipeline - passes pricing-offer/objection-handling/compliance/creative/critic agent results through to createStrategyFromAgentResults as extras", async () => {
  const job = fakeGenerationJob();
  const deps = fakeDeps({
    job,
    agentResults: {
      "campaign-agent": fakeCampaignAgentResult(),
      "budget-agent": fakeBudgetAgentResult(5000),
      "pricing-offer-agent": {
        agent: "pricing-offer-agent", promptId: "pricing-offer-agent", promptVersion: 2,
        data: { recommendedOfferType: "Free trial", pricingPositioning: "n/a", guaranteeOrRiskReversal: "n/a", urgencyAngle: "n/a" },
        confidence: 0.8, evidence: [], usedFallback: false, generatedAt: "now", durationMs: 1,
      },
      "objection-handling-agent": {
        agent: "objection-handling-agent", promptId: "objection-handling-agent", promptVersion: 2,
        data: { topObjections: ["Too expensive?"], rebuttalAngles: ["Cheaper than the leader."], trustSignalsToHighlight: [] },
        confidence: 0.8, evidence: [], usedFallback: false, generatedAt: "now", durationMs: 1,
      },
      "compliance-agent": {
        agent: "compliance-agent", promptId: "compliance-agent", promptVersion: 1,
        data: { overallRisk: "medium", flags: [], restrictedCategoryConcerns: [], recommendation: "Review before launch." },
        confidence: 0.8, evidence: [], usedFallback: false, generatedAt: "now", durationMs: 1,
      },
      "creative-agent": {
        agent: "creative-agent", promptId: "creative-agent", promptVersion: 1,
        data: { headlines: ["Alt A", "Alt B"], primaryTexts: ["Alt body 1"], callToAction: "Sign Up", creativeAngles: ["urgency"] },
        confidence: 0.8, evidence: [], usedFallback: false, generatedAt: "now", durationMs: 1,
      },
      "critic-agent": {
        agent: "critic-agent", promptId: "critic-agent", promptVersion: 1,
        data: { overallScore: 55, issues: [], missingData: ["pricing"], recommendation: "Proceed with caveats." },
        confidence: 0.8, evidence: [], usedFallback: false, generatedAt: "now", durationMs: 1,
      },
      "keyword-agent": {
        agent: "keyword-agent", promptId: "keyword-agent", promptVersion: 1,
        data: { primaryKeywords: ["running shoes"], adGroupSuggestions: ["Footwear"], negativeKeywords: ["free"] },
        confidence: 0.8, evidence: [], usedFallback: false, generatedAt: "now", durationMs: 1,
      },
      "persona-agent": {
        agent: "persona-agent", promptId: "persona-agent", promptVersion: 1,
        data: { personas: [{ name: "Runner", ageRange: "25-34", genderSplit: "balanced", details: "d", interests: ["running"] }] },
        confidence: 0.8, evidence: [], usedFallback: false, generatedAt: "now", durationMs: 1,
      },
      "audience-agent": {
        agent: "audience-agent", promptId: "audience-agent", promptVersion: 1,
        data: { primaryAudience: "Runners", segments: [], painPoints: [], interestTags: ["fitness"], targetingNotes: "n" },
        confidence: 0.8, evidence: [], usedFallback: false, generatedAt: "now", durationMs: 1,
      },
    },
  });

  let capturedExtras: unknown;
  deps.createStrategyFromAgentResults = async (businessId, output, decisionContext, extras) => {
    capturedExtras = extras;
    return {
      id: "strategy-1", businessId, summary: "s", recommendedNetworks: ["meta"], budgetSplit: { meta: 1 },
      audiences: ["Everyone"], creatives: [{ headline: "Hi", body: "Body", callToAction: "Go" }], createdAt: "now",
    };
  };

  await runCampaignGenerationPipeline(job.id, { deps });

  assert.deepStrictEqual(capturedExtras, {
    pricingOffer: { recommendedOfferType: "Free trial", pricingPositioning: "n/a", guaranteeOrRiskReversal: "n/a", urgencyAngle: "n/a" },
    objectionHandling: { topObjections: ["Too expensive?"], rebuttalAngles: ["Cheaper than the leader."], trustSignalsToHighlight: [] },
    compliance: { overallRisk: "medium", flags: [], restrictedCategoryConcerns: [], recommendation: "Review before launch." },
    creative: { headlines: ["Alt A", "Alt B"], primaryTexts: ["Alt body 1"], callToAction: "Sign Up", creativeAngles: ["urgency"] },
    critic: { overallScore: 55, issues: [], missingData: ["pricing"], recommendation: "Proceed with caveats." },
    keyword: { primaryKeywords: ["running shoes"], adGroupSuggestions: ["Footwear"], negativeKeywords: ["free"] },
    persona: { personas: [{ name: "Runner", ageRange: "25-34", genderSplit: "balanced", details: "d", interests: ["running"] }] },
    audience: { primaryAudience: "Runners", segments: [], painPoints: [], interestTags: ["fitness"], targetingNotes: "n" },
    identityConflicts: null, // fakeResearchContext has no metadata.fusion → null
  });
});

test("campaignGenerationPipeline - builds successfully when pricing-offer/objection-handling/compliance agents didn't run at all (extras are undefined, not thrown)", async () => {
  const job = fakeGenerationJob();
  const deps = fakeDeps({ job }); // only campaign-agent + budget-agent, like every pre-existing test in this file

  let capturedExtras: unknown;
  deps.createStrategyFromAgentResults = async (businessId, output, decisionContext, extras) => {
    capturedExtras = extras;
    return {
      id: "strategy-1", businessId, summary: "s", recommendedNetworks: ["meta"], budgetSplit: { meta: 1 },
      audiences: ["Everyone"], creatives: [{ headline: "Hi", body: "Body", callToAction: "Go" }], createdAt: "now",
    };
  };

  const result = await runCampaignGenerationPipeline(job.id, { deps });
  assert.strictEqual(result.campaignId, "campaign-1");
  assert.deepStrictEqual(capturedExtras, { pricingOffer: undefined, objectionHandling: undefined, compliance: undefined, creative: undefined, critic: undefined, keyword: undefined, persona: undefined, audience: undefined, identityConflicts: null });
});

test("campaignGenerationPipeline - threads metadata.fusion.conflicts into the strategy extras as identityConflicts", async () => {
  const job = fakeGenerationJob();
  const deps = fakeDeps({ job });
  const conflicts = [{ kind: "identity-vertical-mismatch" as const, severity: "high" as const, description: "site vs market disjoint", sources: ["website", "market"] }];
  deps.runResearchOrchestrator = async () => ({
    ...fakeResearchContext(),
    metadata: { ...fakeResearchContext().metadata, fusion: { authorityByProvider: {}, fusedConfidenceByProvider: {}, overallFusedConfidence: 0, conflicts, explainability: [] } },
  });

  let capturedExtras: any;
  deps.createStrategyFromAgentResults = async (businessId, output, decisionContext, extras) => {
    capturedExtras = extras;
    return { id: "strategy-1", businessId, summary: "s", recommendedNetworks: ["meta"], budgetSplit: { meta: 1 }, audiences: ["Everyone"], creatives: [{ headline: "Hi", body: "Body", callToAction: "Go" }], createdAt: "now" };
  };

  await runCampaignGenerationPipeline(job.id, { deps });
  assert.deepStrictEqual(capturedExtras.identityConflicts, conflicts, "the fusion conflicts must reach strategy assembly so the identity qualityWarning can fire");
});

test("campaignGenerationPipeline - extracts crawl facts after research but BEFORE the agents run when the crawl was persisted, and skips extraction without a crawlJobId", async () => {
  const job = fakeGenerationJob();
  const calls: string[] = [];

  // With a crawlJobId on the research context: extraction runs, and strictly before agents.
  const deps = fakeDeps({ job });
  deps.runResearchOrchestrator = async () => ({
    ...fakeResearchContext(),
    website: { title: "t", description: "d", excerpt: "e", images: [], crawledPages: [], pagesDiscovered: 1, dataSource: "crawl", crawlJobId: "crawl-1" },
  });
  deps.extractCrawlFacts = async (crawlJobId) => { calls.push(`extract:${crawlJobId}`); return 3; };
  const innerRunAgents = deps.runAgentCoordinator;
  deps.runAgentCoordinator = async (context, options) => { calls.push("agents"); return innerRunAgents(context, options); };

  await runCampaignGenerationPipeline(job.id, { deps });
  assert.deepStrictEqual(calls, ["extract:crawl-1", "agents"], "facts must be in the DB before agents start reading them");

  // Without a crawlJobId (default fake context): extraction must not be called at all.
  const noCrawlDeps = fakeDeps({ job });
  let extractCalled = false;
  noCrawlDeps.extractCrawlFacts = async () => { extractCalled = true; return 0; };
  await runCampaignGenerationPipeline(job.id, { deps: noCrawlDeps });
  assert.strictEqual(extractCalled, false, "no crawl persistence means nothing to extract from");
});

test("campaignGenerationPipeline - a fact-extraction failure never fails campaign generation", async () => {
  const job = fakeGenerationJob();
  const deps = fakeDeps({ job });
  deps.runResearchOrchestrator = async () => ({
    ...fakeResearchContext(),
    website: { title: "t", description: "d", excerpt: "e", images: [], crawledPages: [], pagesDiscovered: 1, dataSource: "crawl", crawlJobId: "crawl-1" },
  });
  deps.extractCrawlFacts = async () => { throw new Error("extraction exploded"); };

  const result = await runCampaignGenerationPipeline(job.id, { deps });
  assert.strictEqual(result.campaignId, "campaign-1", "pipeline must complete despite the extraction failure");
});

test("campaignGenerationPipeline - persists the Decision Engine's output alongside the agent results", async () => {
  const job = fakeGenerationJob();
  const deps = fakeDeps({ job });

  await runCampaignGenerationPipeline(job.id, { deps });

  assert.ok(deps.persistedDecisionContext, "decision context should have been persisted");
  assert.strictEqual(deps.persistedDecisionContext!.businessSummary, "A test business.");
});

test("campaignGenerationPipeline - a Decision Engine failure never fails campaign generation, which still completes normally", async () => {
  const job = fakeGenerationJob();
  const deps = fakeDeps({ job });
  deps.runDecisionEngine = async () => { throw new Error("decision engine exploded"); };

  const result = await runCampaignGenerationPipeline(job.id, { deps });

  assert.strictEqual(result.campaignId, "campaign-1");
  assert.strictEqual(deps.persistedDecisionContext, null, "nothing to persist when the Decision Engine failed");
});

test("campaignGenerationPipeline - uses the Budget agent's recommended daily budget when the job didn't specify one", async () => {
  const job = fakeGenerationJob({ dailyBudgetCents: undefined });
  let capturedBudget: number | undefined;
  const deps = fakeDeps({ job });
  deps.buildCampaignFromStrategy = async (_strategyId, _name, dailyBudgetCents) => {
    capturedBudget = dailyBudgetCents;
    return { id: "campaign-1", businessId: job.businessId, strategyId: "strategy-1", name: "n", status: "draft", networks: ["meta"], dailyBudgetCents, variants: [], createdAt: "now", updatedAt: "now" };
  };

  await runCampaignGenerationPipeline(job.id, { deps });

  assert.strictEqual(capturedBudget, 5000, "should fall back to BudgetAgent's recommendedDailyBudgetCents");
});

test("campaignGenerationPipeline - an explicit job.dailyBudgetCents overrides the Budget agent's recommendation", async () => {
  const job = fakeGenerationJob({ dailyBudgetCents: 12345 });
  let capturedBudget: number | undefined;
  const deps = fakeDeps({ job });
  deps.buildCampaignFromStrategy = async (_strategyId, _name, dailyBudgetCents) => {
    capturedBudget = dailyBudgetCents;
    return { id: "campaign-1", businessId: job.businessId, strategyId: "strategy-1", name: "n", status: "draft", networks: ["meta"], dailyBudgetCents, variants: [], createdAt: "now", updatedAt: "now" };
  };

  await runCampaignGenerationPipeline(job.id, { deps });

  assert.strictEqual(capturedBudget, 12345);
});

test("campaignGenerationPipeline - throws and marks the job failed if the Campaign agent produced no result", async () => {
  const job = fakeGenerationJob();
  const deps = fakeDeps({ job, agentResults: { "budget-agent": fakeBudgetAgentResult(5000) } });

  await assert.rejects(() => runCampaignGenerationPipeline(job.id, { deps }), /campaign-agent did not produce a result/);
  assert.strictEqual(deps.statusHistory.at(-1), "failed");
});

test("campaignGenerationPipeline - throws when the job cannot be loaded", async () => {
  const deps = fakeDeps({ job: fakeGenerationJob() });
  deps.loadJob = async () => null;

  await assert.rejects(() => runCampaignGenerationPipeline("missing-job", { deps }), /not found/);
});

test("campaignGenerationPipeline - acquires the lock keyed by the business id before running any phase", async () => {
  const job = fakeGenerationJob({ businessId: "biz-lock-test" });
  const deps = fakeDeps({ job });
  let capturedKey: string | undefined;
  let capturedTtl: number | undefined;
  let capturedMaxWaitMs: number | undefined;
  deps.withLock = async (key, ttlMs, maxWaitMs, fn) => {
    capturedKey = key;
    capturedTtl = ttlMs;
    capturedMaxWaitMs = maxWaitMs;
    return fn();
  };

  await runCampaignGenerationPipeline(job.id, { deps });

  assert.strictEqual(capturedKey, "campaign-generation:biz-lock-test");
  assert.ok(capturedTtl && capturedTtl > 0);
  assert.ok(capturedMaxWaitMs && capturedMaxWaitMs > 0);
});

test("campaignGenerationPipeline - a lock wait that times out marks the job failed and rejects, without running any phase", async () => {
  const job = fakeGenerationJob();
  const deps = fakeDeps({ job });
  let researchStarted = false;
  deps.createResearchJob = async (...args) => {
    researchStarted = true;
    return { id: "research-1", workspaceId: args[0], businessId: args[2], url: args[1], status: "pending", context: null, createdAt: "now", updatedAt: "now" };
  };
  deps.withLock = async (key, _ttlMs, maxWaitMs) => {
    throw new LockWaitTimeoutError(key, maxWaitMs);
  };

  await assert.rejects(() => runCampaignGenerationPipeline(job.id, { deps }), /Timed out.*waiting for lock/);
  assert.strictEqual(deps.statusHistory.at(-1), "failed");
  assert.strictEqual(researchStarted, false, "no phase should run when the lock wait times out");
});

test("campaignGenerationPipeline - proceeds successfully even when the lock needed several internal poll attempts to acquire", async () => {
  const job = fakeGenerationJob();
  const deps = fakeDeps({ job });
  let simulatedPollAttempts = 0;
  deps.withLock = async (_key, _ttlMs, _maxWaitMs, fn) => {
    // Stands in for withQueuedLock's real poll loop (covered directly, against real Redis,
    // in distributedLock.test.ts) having to retry a few times before acquiring — from the
    // pipeline's perspective, a lock that took several polls to acquire must be
    // indistinguishable from one acquired immediately: fn() still runs, still succeeds.
    simulatedPollAttempts = 3;
    return fn();
  };

  const result = await runCampaignGenerationPipeline(job.id, { deps });

  assert.deepStrictEqual(result, { campaignId: "campaign-1", strategyId: "strategy-1", researchJobId: "research-1" });
  assert.strictEqual(simulatedPollAttempts, 3);
});

// ── Research caching (Phase 1 reuse) ────────────────────────────────────────────────────

/** A cached ResearchContext whose identity matches the default fake job (biz-1 / example.com)
 * so the pipeline's defense-in-depth identity guard accepts it unless a test overrides it. */
function fakeCachedContext(overrides: Partial<ResearchContext> = {}): ResearchContext {
  const base = fakeResearchContext();
  return { ...base, jobId: "cached-research-1", businessId: "biz-1", url: "https://example.com",
    metadata: { ...base.metadata, jobId: "cached-research-1" }, ...overrides };
}

test("campaignGenerationPipeline - (a) cache HIT skips the orchestrator AND fact extraction but still builds a fresh campaign", async () => {
  const job = fakeGenerationJob();
  const deps = fakeDeps({ job });
  let orchestratorCalled = false;
  let extractCalled = false;
  deps.runResearchOrchestrator = async () => { orchestratorCalled = true; return fakeResearchContext(); };
  deps.extractCrawlFacts = async () => { extractCalled = true; return 0; };
  deps.findReusableResearch = async () => ({
    researchJobId: "cached-research-1",
    context: fakeCachedContext({
      website: { title: "t", description: "d", excerpt: "e", images: [], crawledPages: [], pagesDiscovered: 1, dataSource: "crawl", crawlJobId: "crawl-OLD" },
    }),
  });

  const result = await runCampaignGenerationPipeline(job.id, { deps });

  assert.strictEqual(orchestratorCalled, false, "cache hit must NOT re-run the 27-provider orchestrator");
  assert.strictEqual(extractCalled, false, "cache hit must NOT re-extract facts (rows for the reused crawlJobId persist; re-running would duplicate them)");
  assert.strictEqual(result.campaignId, "campaign-1", "a fresh campaign is still built from the cached research");
  assert.strictEqual(result.researchJobId, "cached-research-1", "returns the reused research job's id");
});

test("campaignGenerationPipeline - (b) forceRefresh bypasses the cache entirely and runs fresh research", async () => {
  const job = fakeGenerationJob();
  const deps = fakeDeps({ job });
  let lookupCalled = false;
  let orchestratorCalled = false;
  deps.findReusableResearch = async () => { lookupCalled = true; return { researchJobId: "cached-research-1", context: fakeCachedContext() }; };
  deps.runResearchOrchestrator = async (_jobId, options) => { orchestratorCalled = true; await options?.onProgress?.(9, 9); return fakeResearchContext(); };

  const result = await runCampaignGenerationPipeline(job.id, { deps, forceRefresh: true });

  assert.strictEqual(lookupCalled, false, "forceRefresh must not even consult the cache");
  assert.strictEqual(orchestratorCalled, true, "forceRefresh must run fresh research");
  assert.strictEqual(result.researchJobId, "research-1", "returns the freshly-created research job's id");
});

test("campaignGenerationPipeline - (c) a cached context whose businessId OR url doesn't match the job is rejected (miss + tripwire warning), and fresh research runs", async () => {
  const originalWarn = logger.warn;
  const warnings: string[] = [];
  (logger as unknown as { warn: (...a: unknown[]) => void }).warn = (msg: unknown) => { warnings.push(String(msg)); };
  try {
    for (const badContext of [fakeCachedContext({ url: "https://evil-different-url.com" }), fakeCachedContext({ businessId: "biz-OTHER" })]) {
      const job = fakeGenerationJob();
      const deps = fakeDeps({ job });
      let orchestratorCalled = false;
      deps.findReusableResearch = async () => ({ researchJobId: "cached-research-1", context: badContext });
      deps.runResearchOrchestrator = async (_jobId, options) => { orchestratorCalled = true; await options?.onProgress?.(9, 9); return fakeResearchContext(); };

      const result = await runCampaignGenerationPipeline(job.id, { deps });

      assert.strictEqual(orchestratorCalled, true, "a mismatched cached context must be treated as a miss and re-researched");
      assert.strictEqual(result.researchJobId, "research-1", "must use the fresh research job, never the rejected cached one");
    }
    assert.strictEqual(warnings.length, 2, "each rejection must log exactly one tripwire warning");
    assert.ok(warnings.every((w) => /does not match/.test(w)), `tripwire warnings must explain the mismatch; got: ${warnings.join(" | ")}`);
  } finally {
    (logger as unknown as { warn: unknown }).warn = originalWarn;
  }
});

test("campaignGenerationPipeline - (d) an expired/absent cache (lookup returns null) is a miss that runs fresh, and the configured cache TTL is forwarded to the lookup", async () => {
  const job = fakeGenerationJob();
  const deps = fakeDeps({ job });
  let forwardedTtl: number | undefined;
  let orchestratorCalled = false;
  deps.findReusableResearch = async (_ws, _biz, _url, ttlMs) => { forwardedTtl = ttlMs; return null; }; // null = the WHERE-clause TTL filter matched nothing
  deps.runResearchOrchestrator = async (_jobId, options) => { orchestratorCalled = true; await options?.onProgress?.(9, 9); return fakeResearchContext(); };

  const result = await runCampaignGenerationPipeline(job.id, { deps });

  assert.strictEqual(orchestratorCalled, true, "an expired/absent cache entry must run fresh research");
  assert.strictEqual(result.researchJobId, "research-1");
  // Assert the pipeline forwards its own configured TTL constant (env CAMPAIGN_RESEARCH_CACHE_TTL_MS,
  // falling back to the 6-hour code default) rather than a hardcoded literal — otherwise this test
  // flakes whenever a local/CI .env overrides the TTL. A cached run older than this is a cache miss.
  assert.strictEqual(forwardedTtl, CAMPAIGN_RESEARCH_CACHE_TTL_MS, "the configured cache TTL must be passed to the cache lookup");
});

test("campaignGenerationPipeline - (e) another business's cached research is NEVER served to the agents", async () => {
  const job = fakeGenerationJob({ businessId: "biz-1" });
  const deps = fakeDeps({ job });
  let contextSeenByAgents: ResearchContext | undefined;
  deps.findReusableResearch = async () => ({ researchJobId: "cached-research-OTHER", context: fakeCachedContext({ businessId: "biz-OTHER", jobId: "leaked-from-other-business" }) });
  const innerRunAgents = deps.runAgentCoordinator;
  deps.runAgentCoordinator = async (context, options) => { contextSeenByAgents = context; return innerRunAgents(context, options); };

  const result = await runCampaignGenerationPipeline(job.id, { deps });

  assert.notStrictEqual(contextSeenByAgents?.businessId, "biz-OTHER", "the cross-business context must never reach the agents");
  assert.notStrictEqual(contextSeenByAgents?.jobId, "leaked-from-other-business");
  assert.strictEqual(result.researchJobId, "research-1", "must fall back to fresh research for THIS business");
});

test("campaignGenerationPipeline - (f) on a cache HIT, the new request's budget and name still apply (only research is reused, never the campaign)", async () => {
  const job = fakeGenerationJob({ dailyBudgetCents: 12345, name: "Fresh Name For This Run" });
  const deps = fakeDeps({ job });
  deps.findReusableResearch = async () => ({ researchJobId: "cached-research-1", context: fakeCachedContext() });
  let capturedBudget: number | undefined;
  let capturedName: string | undefined;
  deps.buildCampaignFromStrategy = async (_strategyId, name, dailyBudgetCents) => {
    capturedName = name; capturedBudget = dailyBudgetCents;
    return { id: "campaign-1", businessId: job.businessId, strategyId: "strategy-1", name, status: "draft", networks: ["meta"], dailyBudgetCents, variants: [], createdAt: "now", updatedAt: "now" };
  };

  await runCampaignGenerationPipeline(job.id, { deps });

  assert.strictEqual(capturedBudget, 12345, "budget from the new request must apply on a cache hit");
  assert.strictEqual(capturedName, "Fresh Name For This Run", "name from the new request must apply on a cache hit");
});
