import { test } from "node:test";
import assert from "node:assert";

delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
// Firecrawl's /search now backs runWebSearch — deleted too, or SearchProvider's "zero
// network calls" test below would attempt a real Firecrawl call instead of degrading
// immediately (firecrawlClient.ts reads this key fresh on every call, not frozen).
delete process.env.FIRECRAWL_API_KEY;

// Cache-busting dynamic import (same technique as marketResearch.test.ts): openaiClient.ts
// computes `openai` once at module-evaluation time from OPENAI_API_KEY, so a fresh module
// graph is required after deleting the env var above for SearchProvider to see it unset.
const { SearchProvider } = await import(`../research/providers/SearchProvider.js?t=${Date.now()}`);
const { SEOProvider } = await import(`../research/providers/SEOProvider.js?t=${Date.now()}`);
const { TechnologyProvider } = await import(`../research/providers/TechnologyProvider.js?t=${Date.now()}`);

const baseInput = { jobId: "job-1", workspaceId: "ws-1", url: "https://example.com" };

test("SearchProvider - degrades to a partial result with zero network calls when OPENAI_API_KEY is unset", async () => {
  const original = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as typeof fetch;

  try {
    const provider = new SearchProvider();
    const result = await provider.execute(baseInput);
    assert.strictEqual(result.status, "partial");
    assert.strictEqual(result.data.narrative, "");
    assert.strictEqual(fetchCalled, false, "no OPENAI_API_KEY should mean zero network calls");
  } finally {
    global.fetch = original;
  }
});

test("SEOProvider - extracts meta tags, headings, and frequency-ranked keywords from the fetched page", async () => {
  const html = `<html><head><title>Widgets Inc</title><meta name="description" content="We sell the best widgets"></head>
    <body><h1>Premium Widgets</h1><h2>Widgets for everyone</h2><p>widgets widgets widgets quality quality shipping</p></body></html>`;
  const original = global.fetch;
  global.fetch = (async () => new Response(html, { status: 200 })) as typeof fetch;

  try {
    const provider = new SEOProvider();
    const result = await provider.execute(baseInput);
    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.data.metaTitle, "Widgets Inc");
    assert.strictEqual(result.data.metaDescription, "We sell the best widgets");
    assert.ok(result.data.headings.includes("Premium Widgets"));
    assert.strictEqual(result.data.primaryKeywords[0], "widgets", "highest-frequency word should rank first");
  } finally {
    global.fetch = original;
  }
});

test("SEOProvider - a failed fetch produces a failed ProviderResult rather than throwing", async () => {
  const original = global.fetch;
  global.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;

  try {
    const provider = new SEOProvider();
    const result = await provider.execute(baseInput);
    assert.strictEqual(result.status, "failed");
    assert.strictEqual(result.data, null);
    assert.match(result.error ?? "", /500/);
  } finally {
    global.fetch = original;
  }
});

test("TechnologyProvider - detects CMS/ecommerce/analytics signatures from page markup", async () => {
  const html = `<html><head><script src="https://www.googletagmanager.com/gtm.js"></script></head>
    <body class="woocommerce"><div id="wp-content">wp-content theme markup</div></body></html>`;
  const original = global.fetch;
  global.fetch = (async () => new Response(html, { status: 200, headers: { server: "cloudflare" } })) as typeof fetch;

  try {
    const provider = new TechnologyProvider();
    const result = await provider.execute(baseInput);
    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.data.cms, "WordPress");
    assert.strictEqual(result.data.ecommercePlatform, "WooCommerce");
    assert.ok(result.data.analyticsTools.includes("Google Tag Manager"));
    assert.strictEqual(result.data.hostingProvider, "Cloudflare");
  } finally {
    global.fetch = original;
  }
});
