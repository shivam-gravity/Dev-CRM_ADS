import { test, after } from "node:test";
import assert from "node:assert";
import { disconnectTestInfra } from "./testUtils/disconnectInfra.js";

after(disconnectTestInfra);

delete process.env.OPENAI_API_KEY;
delete process.env.SEARXNG_BASE_URL;
// llmClient.ts's `llm` gate (isGeminiConfigured()) is a frozen module-scope const, evaluated
// once at whichever import first triggers it — unlike the search vendor's key check below,
// which reads process.env fresh on every call. Setting this BEFORE the one-and-only import of
// marketResearch.js in this file is the only point where that freeze can still be influenced;
// a later cache-busted re-import of marketResearch.js would still resolve its own (non-busted)
// `from "../../infra/llmClient.js"` import to this same already-cached instance, so setting it
// any later would have no effect.
process.env.GEMINI_API_KEY = "test-gemini-key";

const { runWebResearch } = await import(`../modules/onboarding/marketResearch.js?t=${Date.now()}`);

test("Market research - runWebResearch falls back to an empty result with no search vendor configured, no network call", async () => {
  // searxngClient.ts reads SEARXNG_BASE_URL fresh on every call (not a frozen module-scope
  // const), so deleting it above guarantees the search short-circuits to "no-key" before
  // ever calling fetch — regardless of whichever earlier test file in this shared process
  // already cached it with a real value frozen in.
  const original = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as typeof fetch;

  try {
    const result = await runWebResearch("What is the pricing for Acme Corp?");
    assert.deepStrictEqual(result, { narrative: "", citations: [], searchesUsed: 0 });
    assert.strictEqual(fetchCalled, false, "no search vendor configured should mean zero network calls — the core cost-control guarantee");
  } finally {
    global.fetch = original;
  }
});

test("Market research - runWebResearch performs a real SearXNG search and converts results into a narrative + citations, when SEARXNG_BASE_URL is configured", async () => {
  // SearXNG backs runWebSearch's default "web-research" task assignment (infra/llmClient.ts
  // -> infra/searchRouter.ts -> infra/searchTaskConfig.ts) and is now the only search
  // backend (Tavily/Serper removed). `llm` is already true (GEMINI_API_KEY was set before
  // this file's one import, above) — only SearXNG's own, freshly-read URL check needs setting here.
  const original = global.fetch;
  process.env.SEARXNG_BASE_URL = "http://localhost:8888";
  global.fetch = (async (url) => {
    const urlStr = String(url instanceof Request ? url.url : url);
    if (urlStr.includes("localhost:8888")) {
      return new Response(
        JSON.stringify({ results: [{ title: "Acme Corp Pricing Guide", url: "https://example.com/acme-pricing", content: "Acme Corp charges $99/mo for its starter plan." }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected fetch: ${urlStr}`);
  }) as typeof fetch;

  try {
    const result = await runWebResearch("What is the pricing for a different, uncached business XYZ123?");
    assert.match(result.narrative, /Acme Corp charges \$99\/mo/);
    assert.deepStrictEqual(result.citations, [{ url: "https://example.com/acme-pricing", title: "Acme Corp Pricing Guide" }]);
    assert.strictEqual(result.searchesUsed, 1);
  } finally {
    global.fetch = original;
    delete process.env.SEARXNG_BASE_URL;
  }
});

test("Market research - when crawl4ai is configured, runWebSearch grounds the narrative in full crawled page content, not just the thin SearXNG snippet", async () => {
  // The quality fix: SearXNG's `content` is a one-line search blurb; crawl4ai fetches the real
  // page body so the LLM gets paragraph-depth grounding (what Tavily's snippet used to give).
  const original = global.fetch;
  process.env.SEARXNG_BASE_URL = "http://localhost:8888";
  process.env.CRAWL4AI_BASE_URL = "http://localhost:11235";
  const fullPageBody = "Acme Corp offers three pricing tiers: Starter at $99/mo, Growth at $299/mo, and Enterprise with custom pricing. Each tier includes SSO, audit logs, and a 99.9% uptime SLA.";
  global.fetch = (async (url) => {
    const urlStr = String(url instanceof Request ? url.url : url);
    if (urlStr.includes("localhost:8888")) {
      return new Response(
        JSON.stringify({ results: [{ title: "Acme Pricing", url: "https://example.com/acme-pricing", content: "Acme pricing page." }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (urlStr.includes("localhost:11235")) {
      return new Response(
        JSON.stringify({ results: [{ success: true, markdown: fullPageBody, status_code: 200, url: "https://example.com/acme-pricing" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected fetch: ${urlStr}`);
  }) as typeof fetch;

  try {
    const result = await runWebResearch("Pricing tiers for yet another uncached business QRS789?");
    // The rich crawled body is what grounds the narrative — not the one-line SearXNG snippet.
    assert.match(result.narrative, /Growth at \$299\/mo/, "narrative should carry the full crawled page content");
    assert.match(result.narrative, /99\.9% uptime SLA/);
    assert.strictEqual(result.searchesUsed, 1);
  } finally {
    global.fetch = original;
    delete process.env.SEARXNG_BASE_URL;
    delete process.env.CRAWL4AI_BASE_URL;
  }
});
