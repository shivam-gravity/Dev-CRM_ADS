import { test } from "node:test";
import assert from "node:assert";

delete process.env.OPENAI_API_KEY;
delete process.env.AWS_BEARER_TOKEN_BEDROCK;
// Firecrawl's /search now backs runWebSearch — deleted too, or the "zero network calls"
// tests below would attempt a real Firecrawl call instead of degrading immediately
// (firecrawlClient.ts reads this key fresh on every call, not frozen).
delete process.env.FIRECRAWL_API_KEY;

const t = Date.now();
const { runMarketIntelligence, computeOpportunityScore, markEstimate } = await import(`../research/market-intelligence/MarketIntelligenceEngine.js?t=${t}`);

test("markEstimate - prefixes an unverified sizing value, is idempotent, and no-ops on empty", () => {
  assert.strictEqual(markEstimate("$42B globally"), "Est. $42B globally");
  assert.strictEqual(markEstimate("Est. $42B globally"), "Est. $42B globally", "must not double-prefix");
  assert.strictEqual(markEstimate("est. 14% CAGR"), "est. 14% CAGR", "already-marked (any case) is left as-is");
  assert.strictEqual(markEstimate(undefined), undefined);
  assert.ok(!markEstimate(""), "empty stays falsy (no 'Est.' prefix on an empty value)");
});

test("runMarketIntelligence - fallback (no key) reports market sizing as NOT grounded", async () => {
  const original = global.fetch;
  global.fetch = (async () => { throw new Error("no network in this test"); }) as typeof fetch;
  try {
    const report = await runMarketIntelligence({ workspaceId: "ws-1", url: "https://example.com", businessName: "Example Co", industry: "widgets" });
    assert.strictEqual(report.marketSizingGrounded, false, "a fallback report never claims grounded market sizing");
  } finally {
    global.fetch = original;
  }
});

test("computeOpportunityScore - high growth/demand with no friction scores at the top of the range", () => {
  assert.strictEqual(computeOpportunityScore("high", "high", 0, 0), 100);
});

test("computeOpportunityScore - low growth/demand scores low even with zero regulatory/competitor friction", () => {
  const score = computeOpportunityScore("low", "low", 0, 0);
  assert.ok(score <= 36, `expected a low score for low/low, got ${score}`);
});

test("computeOpportunityScore - is monotonically non-decreasing as growth/demand level improves, all else equal", () => {
  const levels = ["low", "medium", "high"] as const;
  for (let i = 0; i < levels.length - 1; i++) {
    const lower = computeOpportunityScore(levels[i], levels[i], 2, 2);
    const higher = computeOpportunityScore(levels[i + 1], levels[i + 1], 2, 2);
    assert.ok(higher > lower, `expected ${levels[i + 1]}/${levels[i + 1]} (${higher}) > ${levels[i]}/${levels[i]} (${lower})`);
  }
});

test("computeOpportunityScore - regulatory and competitor friction each pull the score down, but neither alone can zero it out from a high baseline", () => {
  const clean = computeOpportunityScore("high", "high", 0, 0);
  const heavyRegulation = computeOpportunityScore("high", "high", 10, 0);
  const heavyCompetition = computeOpportunityScore("high", "high", 0, 10);
  assert.ok(heavyRegulation < clean);
  assert.ok(heavyCompetition < clean);
  assert.ok(heavyRegulation >= 80, "regulation penalty alone must be capped, not able to crater a strong market's score");
  assert.ok(heavyCompetition >= 80, "competitor penalty alone must be capped, not able to crater a strong market's score");
});

test("computeOpportunityScore - is always clamped to [0, 100]", () => {
  assert.ok(computeOpportunityScore("low", "low", 999, 999) >= 0);
  assert.ok(computeOpportunityScore("high", "high", 0, 0) <= 100);
});

test("runMarketIntelligence - with no OPENAI_API_KEY, degrades to a labeled low-confidence fallback with zero network calls", async () => {
  const original = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as typeof fetch;

  try {
    const report = await runMarketIntelligence({ workspaceId: "ws-1", url: "https://example.com", businessName: "Example Co", industry: "widgets" });

    assert.ok(report.currentMarket.includes("Unknown"));
    assert.strictEqual(report.opportunityScore, 0);
    assert.strictEqual(report.citations.length, 0);
    assert.ok(report.confidence <= 0.2);
    assert.strictEqual(fetchCalled, false);
  } finally {
    global.fetch = original;
  }
});
