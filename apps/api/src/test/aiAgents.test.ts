import { test } from "node:test";
import assert from "node:assert";
import type { ResearchContext } from "../research/types/index.js";
import type { AgentEvidenceItem } from "../agents/types/index.js";

delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;

// Deleting the Gemini key can be load-order-fragile (an earlier test file may have already
// frozen llmClient.ts's `llm` gate with a real key). Blocking `global.fetch` at the module
// level, before any agent module is imported, is what makes "no live model call can succeed"
// deterministic regardless of load order: geminiClient.ts uses plain fetch() per call, so the
// indirection installed before the dynamic (cache-busted) agent imports below covers it.
let currentFetchImpl: typeof fetch = (async () => {
  throw new Error("network unavailable (simulated)");
}) as typeof fetch;
global.fetch = ((...args: Parameters<typeof fetch>) => currentFetchImpl(...args)) as typeof fetch;

const t = Date.now();
const { StrategyAgent } = await import(`../agents/agents/StrategyAgent.js?t=${t}`);
const { CreativeOfferAgent } = await import(`../agents/agents/CreativeOfferAgent.js?t=${t}`);
const { ReviewerAgent } = await import(`../agents/agents/ReviewerAgent.js?t=${t}`);
// Plain (non-busted) import intentionally shares the same singleton the busted agent
// modules use — their static imports resolve without the query param, so it's one registry.
const { promptRegistry } = await import("../agents/prompts/PromptRegistry.js");

function fixtureContext(): ResearchContext {
  return {
    jobId: "job-1",
    workspaceId: "ws-1",
    url: "https://example.com",
    website: { title: "Acme Widgets", description: "We sell widgets", excerpt: "e", images: [], crawledPages: [], pagesDiscovered: 1, dataSource: "crawl" },
    market: { trends: ["growing"], competitionLevel: "medium", dataSource: "search" },
    technology: { analyticsTools: [], frameworks: [], detectedFrom: [], dataSource: "signature" },
    competitors: { competitors: [{ name: "Rival Co" }], competitionIntensity: "high", differentiators: ["price"], dataSource: "search" },
    keywords: { primaryKeywords: ["widgets", "quality"], headings: ["Premium Widgets"], dataSource: "on-page" },
    audience: { primaryAudience: "SMBs", segments: [{ name: "New customers", description: "first-timers" }], painPoints: ["cost"], interestTags: ["widgets"], dataSource: "search" },
    company: { name: "Acme Widgets Inc", summary: "Makes widgets", dataSource: "search" },
    news: { articles: [], summary: "no news", dataSource: "search" },
    metadata: { jobId: "job-1", generatedAt: "now", totalDurationMs: 0, providersSucceeded: [], providersPartial: [], providersFailed: [], confidenceByProvider: {}, overallConfidence: 0 },
  };
}

// The 2 composite PRODUCER super-agents. Each degrades to a labeled fallback (with every
// sub-part populated) when no live model call can succeed.
const PRODUCERS = [
  { Ctor: StrategyAgent, name: "strategy-agent" },
  { Ctor: CreativeOfferAgent, name: "creative-offer-agent" },
];

for (const { Ctor, name } of PRODUCERS) {
  test(`${name} - degrades to a labeled fallback when no live model call can succeed`, async () => {
    const agent = new Ctor();
    const result = await agent.execute(fixtureContext());

    assert.strictEqual(result.agent, name);
    assert.strictEqual(result.promptId, name);
    // Agents always run the registry's latest prompt version (render() with no pin).
    assert.strictEqual(result.promptVersion, promptRegistry.get(name).version);
    assert.strictEqual(result.usedFallback, true);
    assert.strictEqual(result.confidence, 0.2, "a fully-degraded run must report the flat fallback confidence");
    assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0, "every agent must include a non-empty evidence trail");
    assert.ok(result.data && typeof result.data === "object", "every agent must return a JSON-shaped data object");
  });
}

test("StrategyAgent - fallback bundle populates all four sub-parts (campaign/audience/keyword/budget)", async () => {
  const agent = new StrategyAgent();
  const result = await agent.execute(fixtureContext());
  const data = result.data as {
    campaign: { creatives: unknown[]; recommendedNetworks: unknown[] };
    audience: { personas: { name: string }[] };
    keyword: { primaryKeywords: unknown[] };
    budget: { recommendedDailyBudgetCents: number };
  };
  assert.ok(data.campaign.recommendedNetworks.length > 0 && data.campaign.creatives.length > 0, "campaign sub-part must be populated");
  // Personas are derived from audience segments on the fallback path — one per segment.
  assert.strictEqual(data.audience.personas.length, 1);
  assert.strictEqual(data.audience.personas[0].name, "New customers");
  assert.ok(Array.isArray(data.keyword.primaryKeywords), "keyword sub-part must be present");
  assert.ok(data.budget.recommendedDailyBudgetCents > 0, "budget sub-part must have a positive fallback budget");
});

test("CreativeOfferAgent - fallback bundle populates creative/pricingOffer/objectionHandling", async () => {
  const agent = new CreativeOfferAgent();
  const result = await agent.execute(fixtureContext());
  const data = result.data as {
    creative: { headlines: unknown[] };
    pricingOffer: { recommendedOfferType: string };
    objectionHandling: { topObjections: unknown[] };
  };
  assert.ok(data.creative.headlines.length > 0, "creative sub-part must be populated");
  assert.ok(typeof data.pricingOffer.recommendedOfferType === "string", "pricingOffer sub-part must be present");
  assert.ok(Array.isArray(data.objectionHandling.topObjections), "objectionHandling sub-part must be present");
});

test("ReviewerAgent - with no prior results, reports low confidence and asks for a producer to run first", async () => {
  const agent = new ReviewerAgent();
  const result = await agent.execute(fixtureContext(), { priorResults: {} });
  assert.strictEqual(result.confidence, 0.1);
  const data = result.data as { critic: { overallScore: number }; compliance: { overallRisk: string } };
  assert.strictEqual(data.critic.overallScore, 0);
  assert.ok(["low", "medium", "high"].includes(data.compliance.overallRisk));
});

test("ReviewerAgent - with prior results supplied, includes each reviewed agent in its evidence trail", async () => {
  const agent = new ReviewerAgent();
  const priorResults = {
    "campaign-agent": {
      agent: "campaign-agent", promptId: "campaign-agent", promptVersion: 1,
      data: { summary: "Acme" }, confidence: 0.8, evidence: [], usedFallback: false,
      generatedAt: "now", durationMs: 1,
    },
  };
  const result = await agent.execute(fixtureContext(), { priorResults });
  assert.ok(result.evidence.some((e: AgentEvidenceItem) => e.source === "campaign-agent" && /Reviewed/.test(e.detail)));
  assert.strictEqual(result.confidence, 0.2, "a fully-degraded run with non-empty proposals floors at the fallback confidence, not the empty-proposals 0.1");
});
