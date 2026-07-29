import { test } from "node:test";
import assert from "node:assert";
import { ProductProvider } from "../research/providers/ProductProvider.js";
import { NavigationProvider } from "../research/providers/NavigationProvider.js";
import { SearchRankingProvider } from "../research/providers/SearchRankingProvider.js";
import { AdLibraryProvider } from "../research/providers/AdLibraryProvider.js";
import { GoogleSerpFeaturesProvider } from "../research/providers/GoogleSerpFeaturesProvider.js";
import { RedditProvider } from "../research/providers/RedditProvider.js";
import { AutocompleteProvider } from "../research/providers/AutocompleteProvider.js";
import type { ResearchProviderInput } from "../research/types/index.js";

delete process.env.FIRECRAWL_API_KEY;
delete process.env.META_AD_LIBRARY_ACCESS_TOKEN;
delete process.env.OPENAI_API_KEY;
// The real GEMINI_API_KEY leaks in here from another test file's dotenv/config load
// earlier in the same `npm test` process. llmClient.ts's `llm` gate reads it once at module
// load, so a leaked real key would let the crawler-provider structuring step reach Gemini for
// real instead of hitting this file's narrow global.fetch mock — delete it so the call fails
// the same as "unconfigured".
delete process.env.GEMINI_API_KEY;
// SearchRankingProvider now goes through searchRouter (tavily -> serper -> searxng)
// instead of firecrawlSearch directly — all three need clearing for the same reason as
// the LLM keys above, or a real key leaked in from an earlier file lets the chain actually
// reach a live vendor instead of degrading immediately.
delete process.env.TAVILY_API_KEY;
delete process.env.SERPER_API_KEY;
delete process.env.SEARXNG_BASE_URL;

const INPUT: ResearchProviderInput = { jobId: "job-1", workspaceId: "ws-1", url: "https://example.com", businessName: "Example Co", industry: "widgets" };

const FIRECRAWL_GATED_PROVIDERS = [
  { name: "ProductProvider", instance: new ProductProvider() },
  { name: "NavigationProvider", instance: new NavigationProvider() },
  { name: "SearchRankingProvider", instance: new SearchRankingProvider() },
  { name: "AdLibraryProvider", instance: new AdLibraryProvider() },
  { name: "GoogleSerpFeaturesProvider", instance: new GoogleSerpFeaturesProvider() },
  { name: "RedditProvider", instance: new RedditProvider() },
];

for (const { name, instance } of FIRECRAWL_GATED_PROVIDERS) {
  test(`${name} - has a unique provider name and a priority above 200`, () => {
    assert.ok(instance.name.length > 0);
    assert.ok(instance.priority > 200, `expected priority > 200 (this batch runs after the original 20), got ${instance.priority}`);
  });
}

function neverReachFirecrawl(url: string | URL | Request): void {
  const urlStr = String(url instanceof Request ? url.url : url);
  if (urlStr.includes("api.firecrawl.dev")) throw new Error(`must never reach Firecrawl's API host directly: ${urlStr}`);
}

// SearchRankingProvider was NOT converted to try an in-house path first (search has no
// in-house replacement — see scrapeFallback.ts's scope boundary). It still makes zero
// network calls at all when none of the 3 search vendors (tavily/serper/searxng) are
// configured — this is the original, still-valid contract, just against a different
// backend than when this was Firecrawl-only.
test("SearchRankingProvider - degrades to a partial, labeled fallback with zero network calls when no credentials are configured", async () => {
  const original = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as typeof fetch;

  try {
    const result = await new SearchRankingProvider().execute(INPUT);
    assert.strictEqual(result.status, "partial");
    assert.strictEqual(fetchCalled, false);
    assert.ok(result.data, "expected a labeled fallback data object, not null");
  } finally {
    global.fetch = original;
  }
});

// RedditProvider tries OpenAI's own web search first (zero network calls when OPENAI_API_KEY
// is unset, same as every other provider on this fallback pattern), then falls back to
// PullPush.io (infra/pullpushClient.ts) for real threads — unlike Firecrawl, PullPush needs
// no API key, so it's always reached regardless of which credentials are configured. The
// "zero network calls with no credentials" contract above no longer applies to Reddit
// specifically; what still holds is "no OPENAI_API_KEY means no sentiment analysis," which
// this test verifies against a mocked PullPush response instead of a mocked Firecrawl one.
test("RedditProvider - degrades to a partial, labeled fallback when OPENAI_API_KEY is unset (PullPush search still runs — it needs no credential)", async () => {
  const original = global.fetch;
  global.fetch = (async (url) => {
    const urlStr = String(url instanceof Request ? url.url : url);
    if (urlStr.includes("api.pullpush.io/reddit/search/submission")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              title: "Anyone tried Example Co?",
              permalink: "/r/test/comments/abc123/anyone_tried_example_co/",
              selftext: "Just wondering if this widget company is any good.",
              created_utc: 1700000000,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected fetch: ${urlStr}`);
  }) as typeof fetch;

  try {
    const result = await new RedditProvider().execute(INPUT);
    assert.strictEqual(result.status, "partial");
    assert.ok(result.data, "expected a labeled fallback data object, not null");
    assert.match(result.data?.dataSource ?? "", /PullPush/);
  } finally {
    global.fetch = original;
  }
});

// ProductProvider, NavigationProvider, AdLibraryProvider, and GoogleSerpFeaturesProvider were
// converted to try an in-house (Playwright-backed scraper-service, or sitemap-based for map)
// path FIRST via scrapeFallback.ts — regardless of FIRECRAWL_API_KEY. So "no Firecrawl key"
// alone no longer means "zero network calls" for these; the real invariant now is "Firecrawl's
// API host itself is never reached, whether the in-house attempt succeeds or fails."
const FALLBACK_CONVERTED_PROVIDERS = [
  { name: "ProductProvider", instance: new ProductProvider() },
  { name: "NavigationProvider", instance: new NavigationProvider() },
  { name: "AdLibraryProvider", instance: new AdLibraryProvider() },
  { name: "GoogleSerpFeaturesProvider", instance: new GoogleSerpFeaturesProvider() },
];

for (const { name, instance } of FALLBACK_CONVERTED_PROVIDERS) {
  test(`${name} - in-house attempt failing too still degrades to a partial result, never reaching Firecrawl's API host`, async () => {
    const original = global.fetch;
    global.fetch = (async (url) => {
      neverReachFirecrawl(url);
      throw new Error("in-house scraper-service unreachable (simulated)");
    }) as typeof fetch;

    try {
      const result = await instance.execute(INPUT);
      assert.strictEqual(result.status, "partial");
      assert.ok(result.data, "expected a labeled fallback data object, not null");
    } finally {
      global.fetch = original;
    }
  });
}

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/pricing</loc></url></urlset>`;

test("NavigationProvider - a successful in-house sitemap discovery returns success with an in-house dataSource label, never reaching Firecrawl", async () => {
  const original = global.fetch;
  global.fetch = (async (url) => {
    neverReachFirecrawl(url);
    const urlStr = String(url instanceof Request ? url.url : url);
    if (urlStr.includes("/sitemap.xml")) return new Response(SITEMAP_XML, { status: 200 });
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await new NavigationProvider().execute(INPUT);
    assert.strictEqual(result.status, "success");
    assert.match(result.data?.dataSource ?? "", /^In-house/);
    assert.ok(result.data?.pages.some((p) => p.url === "https://example.com/pricing"));
  } finally {
    global.fetch = original;
  }
});

test("AdLibraryProvider - a successful in-house scrape returns an in-house-labeled source, never reaching Firecrawl", async () => {
  const original = global.fetch;
  global.fetch = (async (url) => {
    neverReachFirecrawl(url);
    const urlStr = String(url instanceof Request ? url.url : url);
    if (urlStr.includes("/research/scrape")) {
      return new Response(JSON.stringify({ links: ["https://adstransparency.google.com/advertiser/AR123"], markdown: "", html: "", metadata: {} }), { status: 200 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await new AdLibraryProvider().execute(INPUT);
    assert.strictEqual(result.status, "success");
    assert.match(result.data?.dataSource ?? "", /in-house scrape/);
  } finally {
    global.fetch = original;
  }
});

test("all 6 Firecrawl-gated providers plus Autocomplete have distinct names", () => {
  const names = [...FIRECRAWL_GATED_PROVIDERS.map((p) => p.instance.name), new AutocompleteProvider().name];
  assert.strictEqual(new Set(names).size, names.length);
});

// AutocompleteProvider has no gating credential at all (Google's suggest endpoint is public,
// unauthenticated) — it always attempts a real fetch, so its "no config" contract is instead
// "a fetch failure degrades to an empty, non-throwing partial result."
test("AutocompleteProvider - a fetch failure degrades to a partial result with no suggestions, never throws", async () => {
  const original = global.fetch;
  global.fetch = (async () => {
    throw new Error("network unavailable");
  }) as typeof fetch;

  try {
    const result = await new AutocompleteProvider().execute(INPUT);
    assert.strictEqual(result.status, "partial");
    assert.deepStrictEqual(result.data?.suggestions, []);
  } finally {
    global.fetch = original;
  }
});
