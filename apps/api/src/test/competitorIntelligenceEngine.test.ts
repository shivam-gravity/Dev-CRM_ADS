import { test } from "node:test";
import assert from "node:assert";

delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
// Firecrawl's /search now backs runWebSearch — deleted too, or the "zero network calls"
// test below would attempt a real Firecrawl call instead of degrading immediately
// (firecrawlClient.ts reads this key fresh on every call, not frozen).
delete process.env.FIRECRAWL_API_KEY;

const t = Date.now();
const { runCompetitorIntelligence } = await import(`../research/competitor-intelligence/CompetitorIntelligenceEngine.js?t=${t}`);

test("runCompetitorIntelligence - with no OPENAI_API_KEY, returns a well-formed empty report with zero network calls", async () => {
  const original = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as typeof fetch;

  try {
    const report = await runCompetitorIntelligence({ workspaceId: "ws-1", url: "https://example.com", businessName: "Example Co" });

    assert.strictEqual(report.businessUrl, "https://example.com");
    assert.strictEqual(report.businessName, "Example Co");
    assert.deepStrictEqual(report.competitors, []);
    assert.deepStrictEqual(report.sourcesUsed, []);
    assert.deepStrictEqual(report.fusion.conflicts, []);
    assert.strictEqual(report.fusion.overallConfidence, 0);
    assert.ok(report.generatedAt);
    assert.strictEqual(fetchCalled, false, "no OPENAI_API_KEY should mean zero network calls end to end");
  } finally {
    global.fetch = original;
  }
});
