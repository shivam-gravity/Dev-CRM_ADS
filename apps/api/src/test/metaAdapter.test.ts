import { test } from "node:test";
import assert from "node:assert";

// Runs in the same process as every other test file (see the combined `npm test` invocation)
// — if a file that ran earlier already caused real live credentials to load into process.env
// (e.g. via a Prisma import's dotenv side effect), this file's "mock mode" assumptions would
// silently break. Cleared before the first import of metaAdapter.js (reads these once, at
// module load time), same fix as metaAdapter.live.test.ts's own explicit env setup.
delete process.env.META_ACCESS_TOKEN;
delete process.env.META_AD_ACCOUNT_ID;

const { metaAdapter, toMetaCtaType } = await import("../modules/adapters/metaAdapter.js");

test("toMetaCtaType - maps CTA text to a valid Meta enum, defaulting to LEARN_MORE", () => {
  // Direct enums pass through.
  assert.strictEqual(toMetaCtaType("LEARN_MORE"), "LEARN_MORE");
  assert.strictEqual(toMetaCtaType("SHOP_NOW"), "SHOP_NOW");
  // Title-case / spaced labels normalize to the enum.
  assert.strictEqual(toMetaCtaType("Shop Now"), "SHOP_NOW");
  assert.strictEqual(toMetaCtaType("Learn More"), "LEARN_MORE");
  assert.strictEqual(toMetaCtaType("Sign Up"), "SIGN_UP");
  // Aliases (free-text that isn't a Meta enum) map to the closest valid one.
  assert.strictEqual(toMetaCtaType("Book Live Demo"), "BOOK_NOW");
  assert.strictEqual(toMetaCtaType("Get Started"), "SIGN_UP");
  assert.strictEqual(toMetaCtaType("Buy Now"), "SHOP_NOW");
  // Unknown / empty → safe default.
  assert.strictEqual(toMetaCtaType("Frobnicate the widget"), "LEARN_MORE");
  assert.strictEqual(toMetaCtaType(undefined), "LEARN_MORE");
  assert.strictEqual(toMetaCtaType(""), "LEARN_MORE");
});

test("Meta Ads Adapter - launchVariant fallback placement validation", async () => {
  const result = await metaAdapter.launchVariant({
    campaignId: "camp-test-1",
    variantId: "var-test-1",
    creative: { headline: "Scale Your Lead Gen in 15 Mins", body: "Automated campaigns that convert.", callToAction: "Learn More" },
    dailyBudgetCents: 10000,
  });

  assert.ok(result.externalId, "Should generate a mock ad ID");
  // PAUSED, not active: every ad-creating call in this adapter lands paused so that going live is an
  // explicit, separate step. A mock reporting "active" taught callers to expect the opposite.
  assert.strictEqual(result.status, "paused", "Mock ad must land PAUSED, matching the real publish path");
  assert.ok(result.externalId.startsWith("meta_ad_"), "Ad ID should follow meta prefix pattern");
});

test("Meta Ads Adapter - pauseVariant and setBudget resolve without live credentials", async () => {
  await assert.doesNotReject(() => metaAdapter.pauseVariant("meta_ad_test"));
  await assert.doesNotReject(() => metaAdapter.setBudget({ externalId: "meta_ad_test", dailyBudgetCents: 5000 }));
});

// Explicit credentials bypass mock mode, so the adapter makes real graphPost calls we can capture.
const LIVE_CREDS = { accessToken: "tok", adAccountId: "act_1", currency: "USD", pageId: "page_1" } as const;

test("Meta Ads Adapter - CBO puts daily_budget + bid_strategy on the CAMPAIGN and omits them from the ad set", async () => {
  const original = global.fetch;
  const bodies: Record<string, any> = {};
  global.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(url).includes("/campaigns")) { bodies.campaign = body; return { ok: true, json: async () => ({ id: "camp_1" }) } as Response; }
    if (String(url).includes("/adsets")) { bodies.adset = body; return { ok: true, json: async () => ({ id: "as_1" }) } as Response; }
    throw new Error("unexpected " + url);
  }) as typeof fetch;
  try {
    await metaAdapter.createCampaignContainer!({ name: "C", objective: "OUTCOME_SALES", budgetMode: "CBO", dailyBudgetCents: 5000 }, LIVE_CREDS as any);
    await metaAdapter.createAdSetContainer!({ campaignExternalId: "camp_1", name: "AS", dailyBudgetCents: 5000, budgetMode: "CBO", targeting: {} }, LIVE_CREDS as any);
    assert.ok(bodies.campaign.daily_budget > 0, "CBO campaign carries the budget");
    assert.strictEqual(bodies.campaign.bid_strategy, "LOWEST_COST_WITHOUT_CAP");
    assert.strictEqual(bodies.campaign.is_adset_budget_sharing_enabled, true);
    assert.strictEqual(bodies.adset.daily_budget, undefined, "CBO ad set must omit its own budget");
    assert.strictEqual(bodies.adset.bid_strategy, undefined, "CBO ad set must omit bid_strategy");
  } finally { global.fetch = original; }
});

test("Meta Ads Adapter - ABO (default) keeps budget on the ad set, none on the campaign", async () => {
  const original = global.fetch;
  const bodies: Record<string, any> = {};
  global.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(url).includes("/campaigns")) { bodies.campaign = body; return { ok: true, json: async () => ({ id: "camp_1" }) } as Response; }
    if (String(url).includes("/adsets")) { bodies.adset = body; return { ok: true, json: async () => ({ id: "as_1" }) } as Response; }
    throw new Error("unexpected " + url);
  }) as typeof fetch;
  try {
    await metaAdapter.createCampaignContainer!({ name: "C", objective: "OUTCOME_SALES" }, LIVE_CREDS as any);
    await metaAdapter.createAdSetContainer!({ campaignExternalId: "camp_1", name: "AS", dailyBudgetCents: 5000, targeting: {} }, LIVE_CREDS as any);
    assert.strictEqual(bodies.campaign.daily_budget, undefined, "ABO campaign has no budget");
    assert.strictEqual(bodies.campaign.is_adset_budget_sharing_enabled, false);
    assert.ok(bodies.adset.daily_budget > 0, "ABO ad set carries its own budget");
    assert.strictEqual(bodies.adset.bid_strategy, "LOWEST_COST_WITHOUT_CAP");
  } finally { global.fetch = original; }
});

test("Meta Ads Adapter - createHierarchyAd maps the creative CTA into call_to_action.type", async () => {
  const original = global.fetch;
  let creativeBody: any = null;
  global.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(url).includes("/adcreatives")) { creativeBody = body; return { ok: true, json: async () => ({ id: "cr_1" }) } as Response; }
    if (String(url).includes("/ads")) { return { ok: true, json: async () => ({ id: "ad_1" }) } as Response; }
    throw new Error("unexpected " + url);
  }) as typeof fetch;
  try {
    await metaAdapter.createHierarchyAd!({
      adSetExternalId: "as_1", name: "Ad", landingPageUrl: "https://example.com", imageHash: "h",
      creative: { headline: "H", body: "B", callToAction: "Book Live Demo" },
    }, LIVE_CREDS as any);
    assert.strictEqual(creativeBody.object_story_spec.link_data.call_to_action.type, "BOOK_NOW");
  } finally { global.fetch = original; }
});

test("Meta Ads Adapter - fetchInsights returns honest zeros when no account is connected (no fabricated data)", async () => {
  const stats = await metaAdapter.fetchInsights("meta_ad_test", new Date().toISOString().slice(0, 10));

  // With no credentials the adapter must NOT invent metrics — it returns real zeros so the UI
  // shows a "no data yet" state instead of Math.random() performance presented as real.
  assert.strictEqual(stats.impressions, 0);
  assert.strictEqual(stats.reach, 0);
  assert.strictEqual(stats.clicks, 0);
  assert.strictEqual(stats.conversions, 0);
  assert.strictEqual(stats.spendCents, 0);
});
