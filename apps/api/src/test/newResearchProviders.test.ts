import { test } from "node:test";
import assert from "node:assert";
import type { ResearchProviderInput } from "../research/types/index.js";

delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
// ReviewsProvider/SocialMediaProvider try a real search-then-scrape crawl (searchRouter's
// tavily/serper/searxng chain, then a Firecrawl scrape of whatever URLs that finds) before
// falling back further — unset so the "zero network calls succeed" assertion still holds.
// The blanket module-level fetch-throw below (not per-vendor key deletion) is what actually
// guarantees this: any of tavily/serper/searxng/firecrawl being "configured" just means an
// attempt is made and caught, same graceful-empty result either way.
delete process.env.FIRECRAWL_API_KEY;

// Deleting the Gemini key can be load-order-fragile (an earlier test file may have already
// frozen llmClient.ts's `llm` gate with a real key). Blocking `global.fetch` at the MODULE level
// (not per-test, as this file previously did), before any provider module is imported, is what
// makes "no live model call can succeed" deterministic. Critically, every provider import
// below must be dynamic — a static top-of-file import (as this file previously had) is
// hoisted and resolved before any other code in the file runs, silently loading the whole
// provider->llmClient->geminiClient chain before a fetch override installed later ever takes
// effect. See newAgents.test.ts's doc comment for the same lesson learned the hard way there.
let currentFetchImpl: typeof fetch = (async () => {
  throw new Error("network unavailable (simulated)");
}) as typeof fetch;
global.fetch = ((...args: Parameters<typeof fetch>) => currentFetchImpl(...args)) as typeof fetch;

const t = Date.now();
const { AppStoreProvider } = await import(`../research/providers/AppStoreProvider.js?t=${t}`);
const { BacklinkAuthorityProvider } = await import(`../research/providers/BacklinkAuthorityProvider.js?t=${t}`);
const { ContentMarketingProvider } = await import(`../research/providers/ContentMarketingProvider.js?t=${t}`);
const { FundingProvider } = await import(`../research/providers/FundingProvider.js?t=${t}`);
const { HiringSignalsProvider } = await import(`../research/providers/HiringSignalsProvider.js?t=${t}`);
const { LegalRegulatoryProvider } = await import(`../research/providers/LegalRegulatoryProvider.js?t=${t}`);
const { LocalPresenceProvider } = await import(`../research/providers/LocalPresenceProvider.js?t=${t}`);
const { PartnershipProvider } = await import(`../research/providers/PartnershipProvider.js?t=${t}`);
const { ReviewsProvider } = await import(`../research/providers/ReviewsProvider.js?t=${t}`);
const { SocialMediaProvider } = await import(`../research/providers/SocialMediaProvider.js?t=${t}`);
const { VideoPresenceProvider } = await import(`../research/providers/VideoPresenceProvider.js?t=${t}`);

const INPUT: ResearchProviderInput = { jobId: "job-1", workspaceId: "ws-1", url: "https://example.com", businessName: "Example Co", industry: "widgets" };

const PROVIDERS = [
  { name: "SocialMediaProvider", instance: new SocialMediaProvider() },
  { name: "ReviewsProvider", instance: new ReviewsProvider() },
  { name: "FundingProvider", instance: new FundingProvider() },
  { name: "HiringSignalsProvider", instance: new HiringSignalsProvider() },
  { name: "ContentMarketingProvider", instance: new ContentMarketingProvider() },
  { name: "BacklinkAuthorityProvider", instance: new BacklinkAuthorityProvider() },
  { name: "AppStoreProvider", instance: new AppStoreProvider() },
  { name: "VideoPresenceProvider", instance: new VideoPresenceProvider() },
  { name: "LocalPresenceProvider", instance: new LocalPresenceProvider() },
  { name: "PartnershipProvider", instance: new PartnershipProvider() },
  { name: "LegalRegulatoryProvider", instance: new LegalRegulatoryProvider() },
];

for (const { name, instance } of PROVIDERS) {
  test(`${name} - degrades to a partial, labeled fallback when no live model call can succeed`, async () => {
    const result = await instance.execute(INPUT);
    assert.strictEqual(result.status, "partial");
    assert.strictEqual(result.citations.length, 0);
    assert.ok(result.data, "expected a labeled fallback data object, not null");
  });

  test(`${name} - has a unique provider name and a priority in [100, 200]`, () => {
    assert.ok(instance.name.length > 0);
    assert.ok(instance.priority >= 100 && instance.priority <= 200, `expected priority in [100,200], got ${instance.priority}`);
  });
}

test("all 11 new providers have distinct names", () => {
  const names = PROVIDERS.map((p) => p.instance.name);
  assert.strictEqual(new Set(names).size, names.length);
});
