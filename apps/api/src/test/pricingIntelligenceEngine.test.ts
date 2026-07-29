import { test } from "node:test";
import assert from "node:assert";

// The LLM gate (llmClient.ts's `llm`) is a frozen const set to isGeminiConfigured() at first
// module load. A STATIC import of the engine here would be hoisted ahead of the deletes below
// and freeze that gate while the real GEMINI_API_KEY (loaded from apps/api/.env by an
// earlier test file's dotenv/config) is still present — making the "zero network calls" degrade
// tests attempt a real Gemini call. So scrub the key FIRST, then dynamically import the engine
// (pure helpers included) so llmClient freezes to `false`. See audienceIntelligenceEngine.test.ts.
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
// Firecrawl's /search now backs runWebSearch (infra/llmClient.ts) — this must be deleted
// too, or this file's "zero network calls" tests below would actually attempt a real
// Firecrawl call instead of degrading immediately (firecrawlClient.ts reads this key fresh
// on every call, not frozen, so deleting it here — before the test body runs — is enough;
// no cache-busting needed for this specific key).
delete process.env.FIRECRAWL_API_KEY;
const { computePosition, median, runPricingIntelligence } = await import(`../research/pricing-intelligence/PricingIntelligenceEngine.js?t=${Date.now()}`);

test("median - odd-length array returns the middle value", () => {
  assert.strictEqual(median([10, 30, 20]), 20);
});

test("median - even-length array averages the two middle values", () => {
  assert.strictEqual(median([10, 20, 30, 40]), 25);
});

test("median - empty array returns null", () => {
  assert.strictEqual(median([]), null);
});

test("computePosition - below the entire competitor range", () => {
  assert.strictEqual(computePosition(10, [50, 60, 70]), "below-range");
});

test("computePosition - above the entire competitor range", () => {
  assert.strictEqual(computePosition(100, [50, 60, 70]), "above-range");
});

test("computePosition - low end, mid-range, and high end within the range", () => {
  assert.strictEqual(computePosition(51, [50, 100]), "low-end");
  assert.strictEqual(computePosition(75, [50, 100]), "mid-range");
  assert.strictEqual(computePosition(99, [50, 100]), "high-end");
});

test("computePosition - unknown when the company's price or competitor prices are missing", () => {
  assert.strictEqual(computePosition(null, [50, 100]), "unknown");
  assert.strictEqual(computePosition(50, []), "unknown");
});


test("runPricingIntelligence - with no OPENAI_API_KEY, degrades gracefully with zero network calls", async () => {
  const original = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as typeof fetch;

  try {
    const report = await runPricingIntelligence({
      workspaceId: "ws-1", url: "https://example.com", businessName: "Example Co",
      competitors: [{ name: "Rival Co" }],
    });

    assert.strictEqual(report.company.startingPriceUsd, null);
    assert.strictEqual(report.median, null);
    assert.strictEqual(report.range, null);
    assert.strictEqual(report.position, "unknown");
    assert.ok(report.recommendations.length > 0);
    assert.strictEqual(fetchCalled, false);
  } finally {
    global.fetch = original;
  }
});
