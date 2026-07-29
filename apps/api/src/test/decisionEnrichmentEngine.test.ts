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

delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
// Firecrawl's /search now backs runWebSearch — deleted too, or the "zero network calls"
// test below would attempt a real Firecrawl call instead of degrading immediately
// (firecrawlClient.ts reads this key fresh on every call, not frozen).
delete process.env.FIRECRAWL_API_KEY;
const t = Date.now();
const { enrichBusinessContext } = await import(`../research/decision/enrichment-engine.js?t=${t}`);

test("enrichBusinessContext - with no OPENAI_API_KEY, returns empty results with zero network calls", async () => {
  const original = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => { fetchCalled = true; throw new Error("should not be called"); }) as typeof fetch;

  try {
    const result = await enrichBusinessContext(fakeContext());
    assert.deepStrictEqual(result, { pricingTiers: [], notableCustomers: [], quantifiedProofPoints: [], regionalMarketDepth: null });
    assert.strictEqual(fetchCalled, false);
  } finally {
    global.fetch = original;
  }
});

test("enrichBusinessContext - regionalMarketDepth is null when the context has no recommendedRegion, even with a key", async () => {
  // No key set in this process, so this exercises the same no-key early-return path, but
  // specifically documents that regionalMarketDepth requires context.market.recommendedRegion.
  const result = await enrichBusinessContext(fakeContext({ market: { competitionLevel: "medium", trends: [], dataSource: "test" } }));
  assert.strictEqual(result.regionalMarketDepth, null);
});
