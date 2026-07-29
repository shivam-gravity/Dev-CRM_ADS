import { test } from "node:test";
import assert from "node:assert";

delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
// Firecrawl's /search now backs runWebSearch — deleted too, or the "zero network calls"
// test below would attempt a real Firecrawl call instead of degrading immediately
// (firecrawlClient.ts reads this key fresh on every call, not frozen).
delete process.env.FIRECRAWL_API_KEY;

// Cache-busting dynamic import (same technique used throughout research/providers and
// agents tests): infra/openaiClient.ts computes `openai` once at module-evaluation time.
const t = Date.now();
const { discoverCompetitors, mergeDiscoveredCompetitors } = await import(`../research/competitor-intelligence/discovery.js?t=${t}`);

test("mergeDiscoveredCompetitors - a name found by multiple sources is deduplicated and both sources are recorded", () => {
  const { competitors, sourcesUsed } = mergeDiscoveredCompetitors([
    { source: "direct-search", names: [{ name: "Acme Corp", url: "https://acme.com" }] },
    { source: "alternatives-search", names: [{ name: "acme corp" }, { name: "Widgetco" }] },
  ]);

  assert.strictEqual(competitors.length, 2, "Acme Corp should be merged into one entry despite casing differences");
  const acme = competitors.find((c: any) => c.name === "Acme Corp");
  assert.deepStrictEqual(acme.mentionedBy.sort(), ["alternatives-search", "direct-search"]);
  assert.strictEqual(acme.url, "https://acme.com", "URL from whichever source provided one should be kept");
  assert.deepStrictEqual(sourcesUsed.sort(), ["alternatives-search", "direct-search"]);
});

test("mergeDiscoveredCompetitors - a source that found nothing doesn't appear in sourcesUsed", () => {
  const { sourcesUsed } = mergeDiscoveredCompetitors([
    { source: "direct-search", names: [{ name: "Acme Corp" }] },
    { source: "research-memory", names: [] },
  ]);
  assert.deepStrictEqual(sourcesUsed, ["direct-search"]);
});

test("mergeDiscoveredCompetitors - blank/whitespace-only names are dropped", () => {
  const { competitors } = mergeDiscoveredCompetitors([{ source: "direct-search", names: [{ name: "  " }, { name: "Real Co" }] }]);
  assert.strictEqual(competitors.length, 1);
  assert.strictEqual(competitors[0].name, "Real Co");
});

test("discoverCompetitors - with no OPENAI_API_KEY, all sources degrade to empty with zero network calls", async () => {
  const original = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as typeof fetch;

  try {
    const { competitors, sourcesUsed } = await discoverCompetitors({ workspaceId: "ws-1", url: "https://example.com" });
    assert.deepStrictEqual(competitors, []);
    assert.deepStrictEqual(sourcesUsed, []);
    assert.strictEqual(fetchCalled, false, "no OPENAI_API_KEY should mean zero network calls across all 3 sources");
  } finally {
    global.fetch = original;
  }
});
