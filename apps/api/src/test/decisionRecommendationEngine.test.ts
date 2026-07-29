import { test } from "node:test";
import assert from "node:assert";
import type { ResearchContext } from "../research/types/index.js";

function fakeContext(overrides: Partial<ResearchContext> = {}): ResearchContext {
  return {
    jobId: "research-1", workspaceId: "ws-1", url: "https://example.com",
    website: null, market: null, technology: null, competitors: null, keywords: null, audience: null, company: null, news: null,
    metadata: { jobId: "research-1", generatedAt: new Date().toISOString(), totalDurationMs: 0, providersSucceeded: [], providersPartial: [], providersFailed: [], confidenceByProvider: {}, overallConfidence: 0 },
    ...overrides,
  };
}

// "Zero network calls" requires the single LLM backend (Gemini, gated on
// GEMINI_API_KEY) to be unconfigured. Deleting it before the cache-busted dynamic
// import below leaves the router with nothing to call.
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
const t = Date.now();
const { generateRecommendations, CATEGORY_FIELDS, computeRecommendationConfidence } = await import(`../research/decision/recommendation-engine.js?t=${t}`);

test("generateRecommendations - with no OPENAI_API_KEY, returns a labeled low-confidence fallback with zero network calls", async () => {
  const original = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as typeof fetch;

  try {
    const recommendations = await generateRecommendations(fakeContext());
    assert.ok(recommendations.length > 0);
    assert.strictEqual(recommendations[0].category, "positioning");
    assert.strictEqual(recommendations[0].confidence, 0.2, "no backing context fields -> baseline low confidence");
    assert.strictEqual(fetchCalled, false);
  } finally {
    global.fetch = original;
  }
});

test("generateRecommendations - fallback recommendation's evidence reflects whichever context fields ARE present", async () => {
  const context = fakeContext({
    company: { name: "Acme", summary: "Acme sells widgets.", dataSource: "test" },
    market: { competitionLevel: "medium", trends: ["AI adoption"], dataSource: "test" },
    metadata: { jobId: "research-1", generatedAt: new Date().toISOString(), totalDurationMs: 0, providersSucceeded: ["company", "market"], providersPartial: [], providersFailed: [], confidenceByProvider: { company: 0.7, market: 0.6 }, overallConfidence: 0.65 },
  });
  const recommendations = await generateRecommendations(context);
  const positioning = recommendations.find((r: { category: string }) => r.category === "positioning");
  assert.ok(positioning, "expected a positioning recommendation");
  assert.ok(positioning.evidence.some((e: string) => e.includes("Acme sells widgets")));
  assert.ok(positioning.evidence.some((e: string) => e.includes("competition=medium")));
  assert.ok(positioning.confidence > 0.2, "some backing fields present -> confidence above the zero-field baseline");
});

test("computeRecommendationConfidence - a category outside the known enum degrades to the 0.2 baseline instead of throwing (live bug: the model's structured output isn't runtime-validated against the enum)", () => {
  const context = fakeContext({ company: { name: "Acme", summary: "Acme sells widgets.", dataSource: "test" } });
  assert.strictEqual(computeRecommendationConfidence(context, "not-a-real-category"), 0.2);
});

test("CATEGORY_FIELDS - every category maps to at least one ResearchContext field", () => {
  for (const category of Object.keys(CATEGORY_FIELDS)) {
    assert.ok(CATEGORY_FIELDS[category].length > 0, `${category} should map to at least one field`);
  }
});

test("generateRecommendations - each returned recommendation has every required field", async () => {
  const recommendations = await generateRecommendations(fakeContext());
  for (const r of recommendations) {
    for (const key of ["id", "title", "category", "priority", "impact", "confidence", "reason", "evidence", "affectedAudience", "estimatedDifficulty", "expectedOutcome"]) {
      assert.ok(key in r, `missing field ${key}`);
    }
  }
});
