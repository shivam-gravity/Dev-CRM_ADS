import { test } from "node:test";
import assert from "node:assert";

delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
// Firecrawl's /search now backs runWebSearch — deleted too, or the "zero network calls"
// test below would attempt a real Firecrawl call instead of degrading immediately
// (firecrawlClient.ts reads this key fresh on every call, not frozen).
delete process.env.FIRECRAWL_API_KEY;

const t = Date.now();
const { runAudienceIntelligence } = await import(`../research/audience-intelligence/AudienceIntelligenceEngine.js?t=${t}`);

test("runAudienceIntelligence - with no OPENAI_API_KEY, degrades to a labeled low-confidence fallback with zero network calls", async () => {
  const original = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as typeof fetch;

  try {
    const report = await runAudienceIntelligence({ workspaceId: "ws-1", url: "https://example.com", businessName: "Example Co" });

    assert.ok(report.icp.summary.includes("Unknown"));
    assert.deepStrictEqual(report.icp.firmographics, []);
    assert.deepStrictEqual(report.icp.behavioralSignals, []);
    assert.strictEqual(report.citations.length, 0);
    assert.strictEqual(report.evidence.length, 0);
    assert.ok(report.confidence <= 0.2);
    for (const field of ["decisionMakers", "buyingTriggers", "painPoints", "objections", "motivations", "channels", "personas"]) {
      assert.ok(Array.isArray(report[field]) && report[field].length > 0, `${field} must be populated even in fallback`);
    }
    assert.strictEqual(fetchCalled, false);
  } finally {
    global.fetch = original;
  }
});
