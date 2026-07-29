import { test } from "node:test";
import assert from "node:assert";
import type { ResearchContext } from "../research/types/index.js";
import type { Recommendation } from "../research/decision/types.js";

function fakeContext(overrides: Partial<ResearchContext> = {}): ResearchContext {
  return {
    jobId: "research-1", workspaceId: "ws-1", url: "https://example.com",
    website: null, market: null, technology: null, competitors: null, keywords: null, audience: null, company: null, news: null,
    metadata: { jobId: "research-1", generatedAt: new Date().toISOString(), totalDurationMs: 0, providersSucceeded: [], providersPartial: [], providersFailed: [], confidenceByProvider: {}, overallConfidence: 0 },
    ...overrides,
  };
}

function fakeRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: "rec-1", title: "Do the thing", category: "positioning", priority: "high", impact: "high",
    confidence: 0.6, reason: "because", evidence: ["Company: Acme sells widgets."],
    affectedAudience: "Everyone", estimatedDifficulty: "medium", expectedOutcome: "More sales",
    ...overrides,
  };
}

delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
const t = Date.now();
const { computeFinalScore, rankRecommendations, DEFAULT_WEIGHTS } = await import(`../research/decision/ranking-engine.js?t=${t}`);

test("computeFinalScore - all factors at 1 with default weights scores 100", () => {
  const factors = { researchConfidence: 1, evidenceQuality: 1, sourceAuthority: 1, freshness: 1, businessRelevance: 1, crossProviderAgreement: 1, historicalSuccess: 1 };
  assert.strictEqual(computeFinalScore(factors, DEFAULT_WEIGHTS), 100);
});

test("computeFinalScore - all factors at 0 scores 0", () => {
  const factors = { researchConfidence: 0, evidenceQuality: 0, sourceAuthority: 0, freshness: 0, businessRelevance: 0, crossProviderAgreement: 0, historicalSuccess: 0 };
  assert.strictEqual(computeFinalScore(factors, DEFAULT_WEIGHTS), 0);
});

test("computeFinalScore - weights sum to 1, so a single factor at 1 (rest 0) contributes exactly its own weight * 100", () => {
  const factors = { researchConfidence: 1, evidenceQuality: 0, sourceAuthority: 0, freshness: 0, businessRelevance: 0, crossProviderAgreement: 0, historicalSuccess: 0 };
  assert.strictEqual(computeFinalScore(factors, DEFAULT_WEIGHTS), DEFAULT_WEIGHTS.researchConfidence * 100);
});

test("rankRecommendations - sorts descending by finalScore and every ranked item carries its rankingFactors", async () => {
  const context = fakeContext({ company: { name: "Acme", summary: "Acme sells widgets.", dataSource: "test" } });
  const weak = fakeRecommendation({ id: "rec-weak", confidence: 0.1, evidence: [] });
  const strong = fakeRecommendation({ id: "rec-strong", confidence: 0.9, evidence: ["a", "b", "c"] });

  const ranked = await rankRecommendations([weak, strong], context);
  assert.strictEqual(ranked.length, 2);
  assert.strictEqual(ranked[0].id, "rec-strong");
  assert.ok(ranked[0].finalScore >= ranked[1].finalScore);
  for (const r of ranked) {
    assert.ok(r.rankingFactors);
    assert.ok(typeof r.finalScore === "number");
  }
});

test("rankRecommendations - historicalSuccess degrades to a neutral 0.5 when Research Memory is unreachable (no OPENAI_API_KEY)", async () => {
  const context = fakeContext();
  const ranked = await rankRecommendations([fakeRecommendation()], context);
  assert.strictEqual(ranked[0].rankingFactors.historicalSuccess, 0.5);
});

test("rankRecommendations - crossProviderAgreement defaults to a neutral value when there's no Knowledge Fusion report", async () => {
  const context = fakeContext();
  const ranked = await rankRecommendations([fakeRecommendation()], context);
  assert.strictEqual(ranked[0].rankingFactors.crossProviderAgreement, 0.7);
});
