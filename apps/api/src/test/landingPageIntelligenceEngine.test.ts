import { test } from "node:test";
import assert from "node:assert";

delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
const t = Date.now();
const { runLandingPageIntelligence } = await import(`../research/landing-page-intelligence/LandingPageIntelligenceEngine.js?t=${t}`);

const FAKE_HTML = `<html><head><title>Acme Widgets</title><meta name="description" content="Buy the best widgets"></head>
  <body><h1>Premium Widgets</h1><h2>For every business</h2><img src="a.png"><img src="b.png"></body></html>`;

test("runLandingPageIntelligence - with no OPENAI_API_KEY, still fetches+parses the real page but skips the LLM analysis, degrading that part to fallback", async () => {
  const original = global.fetch;
  global.fetch = (async () => new Response(FAKE_HTML, { status: 200 })) as typeof fetch;

  try {
    const report = await runLandingPageIntelligence({ workspaceId: "ws-1", url: "https://example.com", businessName: "Acme" });

    assert.strictEqual(report.seo.title, "Acme Widgets", "SEO extraction doesn't need the LLM and must still work");
    assert.strictEqual(report.seo.headingCount, 2);
    assert.ok(report.hero.includes("Unknown"), "LLM-derived fields must degrade to fallback without an API key");
    assert.ok(report.confidence <= 0.2);
    assert.ok(report.performanceHints.length > 0);
  } finally {
    global.fetch = original;
  }
});

test("runLandingPageIntelligence - an unreachable page degrades to a clear, low-confidence fallback rather than throwing", async () => {
  const original = global.fetch;
  global.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;

  try {
    const report = await runLandingPageIntelligence({ workspaceId: "ws-1", url: "https://unreachable.example.com" });
    assert.ok(report.confidence <= 0.2);
    assert.ok(report.performanceHints[0].toLowerCase().includes("could not fetch"));
  } finally {
    global.fetch = original;
  }
});

test("runLandingPageIntelligence - flags a large page HTML size as a performance hint", async () => {
  const original = global.fetch;
  const bigHtml = `<html><head><title>Big Page</title></head><body>${"x".repeat(600 * 1024)}</body></html>`;
  global.fetch = (async () => new Response(bigHtml, { status: 200 })) as typeof fetch;

  try {
    const report = await runLandingPageIntelligence({ workspaceId: "ws-1", url: "https://example.com" });
    assert.ok(report.performanceHints.some((h: string) => h.toLowerCase().includes("large")));
  } finally {
    global.fetch = original;
  }
});
