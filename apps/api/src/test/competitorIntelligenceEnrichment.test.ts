import { test } from "node:test";
import assert from "node:assert";

delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
// Firecrawl's /search now backs runWebSearch — deleted too, or the "zero network calls"
// test below would attempt a real Firecrawl call instead of degrading immediately
// (firecrawlClient.ts reads this key fresh on every call, not frozen).
delete process.env.FIRECRAWL_API_KEY;

const t = Date.now();
const { enrichCompetitor } = await import(`../research/competitor-intelligence/enrichment.js?t=${t}`);

test("enrichCompetitor - with no OPENAI_API_KEY, degrades to a labeled low-confidence fallback with zero network calls", async () => {
  const original = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as typeof fetch;

  try {
    const profile = await enrichCompetitor({ name: "Acme Corp", mentionedBy: ["direct-search"] }, { industry: "widgets" });

    assert.strictEqual(profile.name, "Acme Corp");
    assert.strictEqual(profile.citations.length, 0);
    assert.strictEqual(profile.evidence.length, 0);
    assert.ok(profile.confidence <= 0.2, "a total fallback must report low confidence");
    assert.strictEqual(profile.mentionedBySourceCount, 1);
    assert.ok(profile.strengths.length > 0 && profile.weaknesses.length > 0, "even the fallback must return every required field, not partial data");
    assert.strictEqual(fetchCalled, false);
  } finally {
    global.fetch = original;
  }
});

test("enrichCompetitor - carries mentionedBySourceCount through from the discovered competitor", async () => {
  const profile = await enrichCompetitor({ name: "Acme Corp", mentionedBy: ["direct-search", "alternatives-search", "research-memory"] }, {});
  assert.strictEqual(profile.mentionedBySourceCount, 3);
});

test("enrichCompetitor - preserves the discovered URL", async () => {
  const profile = await enrichCompetitor({ name: "Acme Corp", url: "https://acme.com", mentionedBy: ["direct-search"] }, {});
  assert.strictEqual(profile.url, "https://acme.com");
});
