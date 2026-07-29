import { test } from "node:test";
import assert from "node:assert";
import type { ResearchContext } from "../research/types/index.js";
import type { RankedRecommendation } from "../research/decision/types.js";

function fakeContext(overrides: Partial<ResearchContext> = {}): ResearchContext {
  return {
    jobId: "research-1", workspaceId: "ws-1", url: "https://example.com",
    website: null, market: null, technology: null, competitors: null, keywords: null, audience: null, company: null, news: null,
    metadata: { jobId: "research-1", generatedAt: new Date().toISOString(), totalDurationMs: 0, providersSucceeded: [], providersPartial: [], providersFailed: [], confidenceByProvider: {}, overallConfidence: 0.5 },
    ...overrides,
  };
}

function fakeRanked(overrides: Partial<RankedRecommendation> = {}): RankedRecommendation {
  return {
    id: "rec-1", title: "Do the thing", category: "positioning", priority: "high", impact: "high",
    confidence: 0.6, reason: "because", evidence: [], affectedAudience: "Everyone",
    estimatedDifficulty: "medium", expectedOutcome: "More sales",
    rankingFactors: { researchConfidence: 0.6, evidenceQuality: 0.5, sourceAuthority: 0.5, freshness: 1, businessRelevance: 0.5, crossProviderAgreement: 0.7, historicalSuccess: 0.5 },
    finalScore: 60,
    ...overrides,
  };
}

// "Zero network calls" requires the single LLM backend (Gemini, gated on
// GEMINI_API_KEY) to be unconfigured. Deleting it before the cache-busted dynamic
// import below leaves the router with nothing to call.
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
const t = Date.now();
const { generateStrategies } = await import(`../research/decision/strategy-engine.js?t=${t}`);

test("generateStrategies - with no OPENAI_API_KEY, returns exactly 3 labeled fallback strategies with zero network calls", async () => {
  const original = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => { fetchCalled = true; throw new Error("should not be called"); }) as typeof fetch;

  try {
    const strategies = await generateStrategies(fakeContext(), [fakeRanked()]);
    assert.strictEqual(strategies.length, 3);
    assert.deepStrictEqual(strategies.map((s: { label: string }) => s.label), ["Strategy A", "Strategy B", "Strategy C"]);
    assert.strictEqual(fetchCalled, false);
  } finally {
    global.fetch = original;
  }
});

test("generateStrategies - every strategy has the full required field set", async () => {
  const strategies = await generateStrategies(fakeContext(), [fakeRanked()]);
  for (const s of strategies) {
    for (const key of ["id", "label", "targetAudience", "platforms", "objective", "budgetDailyCents", "creativeDirection", "messaging", "offer", "expectedKpi", "strengths", "weaknesses", "confidence"]) {
      assert.ok(key in s, `missing field ${key}`);
    }
  }
});

test("generateStrategies - confidence blends overall research confidence with the top recommendations' scores, and is shared across all 3 fallback strategies", async () => {
  const context = fakeContext({ metadata: { jobId: "research-1", generatedAt: new Date().toISOString(), totalDurationMs: 0, providersSucceeded: [], providersPartial: [], providersFailed: [], confidenceByProvider: {}, overallConfidence: 0.8 } });
  const strategies = await generateStrategies(context, [fakeRanked({ finalScore: 100 })]);
  const expected = Math.round(((0.8 + 1) / 2) * 100) / 100;
  assert.strictEqual(strategies[0].confidence, expected);
  assert.ok(strategies.every((s: { confidence: number }) => s.confidence === expected));
});

test("generateStrategies - with zero recommendations, confidence falls back to overall research confidence alone", async () => {
  const context = fakeContext({ metadata: { jobId: "research-1", generatedAt: new Date().toISOString(), totalDurationMs: 0, providersSucceeded: [], providersPartial: [], providersFailed: [], confidenceByProvider: {}, overallConfidence: 0.42 } });
  const strategies = await generateStrategies(context, []);
  assert.strictEqual(strategies[0].confidence, 0.42);
});
