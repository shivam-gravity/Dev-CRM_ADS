import { test } from "node:test";
import assert from "node:assert";
import type { Recommendation } from "../research/decision/types.js";

function fakeRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: "rec-1", title: "Do the thing", category: "positioning", priority: "high", impact: "high",
    confidence: 0.6, reason: "because", evidence: [],
    affectedAudience: "Everyone", estimatedDifficulty: "medium", expectedOutcome: "More sales",
    ...overrides,
  };
}

// "Zero network calls" requires the single LLM backend (Gemini, gated on
// GEMINI_API_KEY) to be unconfigured. Deleting it before the cache-busted dynamic
// import below leaves the router with nothing to call.
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
const t = Date.now();
const { analyzeTradeoffs } = await import(`../research/decision/tradeoff-engine.js?t=${t}`);

test("analyzeTradeoffs - an empty recommendation list returns an empty array with zero network calls", async () => {
  const original = global.fetch;
  global.fetch = (async () => { throw new Error("should not be called"); }) as typeof fetch;
  try {
    const result = await analyzeTradeoffs([]);
    assert.deepStrictEqual(result, []);
  } finally {
    global.fetch = original;
  }
});

test("analyzeTradeoffs - with no OPENAI_API_KEY, returns one labeled fallback trade-off per recommendation, in order, with zero network calls", async () => {
  const original = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => { fetchCalled = true; throw new Error("should not be called"); }) as typeof fetch;

  try {
    const recA = fakeRecommendation({ id: "rec-a" });
    const recB = fakeRecommendation({ id: "rec-b", expectedOutcome: "Less churn" });
    const result = await analyzeTradeoffs([recA, recB]);

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].recommendationId, "rec-a");
    assert.strictEqual(result[1].recommendationId, "rec-b");
    assert.ok(result[0].benefits.includes("More sales"));
    assert.ok(result[1].benefits.includes("Less churn"));
    assert.strictEqual(result[0].implementationComplexity, "medium");
    assert.strictEqual(fetchCalled, false);
  } finally {
    global.fetch = original;
  }
});
