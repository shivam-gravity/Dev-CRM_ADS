import { test, after, mock } from "node:test";
import assert from "node:assert";
import { prisma } from "../db/prisma.js";
import { disconnectTestInfra } from "./testUtils/disconnectInfra.js";
import { metaAdapter } from "../modules/adapters/metaAdapter.js";

// This file's tests assert mock-mode ("safety default: paused") adapter behavior — real
// live credentials sitting in .env (e.g. for a real manual Meta-ads test) must not leak
// in here, or these calls hit the real Graph API with fake test data and fail unpredictably
// instead of exercising the mock path. Cleared before the first import of
// campaignOrchestrator.js (which imports metaAdapter.js/googleAdapter.js/tiktokAdapter.js —
// each reads its live-credential env vars once, at module load time).
for (const key of [
  "META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID",
  "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ADS_ACCESS_TOKEN",
  "TIKTOK_ACCESS_TOKEN", "TIKTOK_ADVERTISER_ID",
]) delete process.env[key];

const {
  buildCampaignFromStrategy,
  launchCampaign,
  pauseVariant,
  reallocateBudget,
  activateVariant,
  applyCreativeMedia,
  saveCampaign,
} = await import("../modules/orchestrator/campaignOrchestrator.js");

// launchCampaign publishes "campaign.launched" via infra/eventBus.js, which is Redis
// Streams-backed (see redisStreamEventBus.ts) — that opens a real connection on this
// file's first launchCampaign call, same class of "open handle hangs node --test after
// the last test finishes" issue as metaLeadWebhook.test.ts's queue imports.
after(disconnectTestInfra);

// Setup helper to insert strategy
async function seedTestStrategy(id: string, businessId: string) {
  const strategyData = {
    id,
    businessId,
    summary: "Test strategy overview",
    recommendedNetworks: ["meta", "google", "tiktok"],
    budgetSplit: { meta: 0.34, google: 0.33, tiktok: 0.33 },
    audiences: ["Custom Lookalike"],
    creatives: [
      { headline: "Headline 1", body: "Body 1", callToAction: "Learn More" },
      { headline: "Headline 2", body: "Body 2", callToAction: "Shop Now" }
    ],
    createdAt: new Date().toISOString()
  };

  await prisma.strategy.upsert({
    where: { id },
    create: { id, businessId, data: strategyData, createdAt: new Date(strategyData.createdAt) },
    update: { data: strategyData },
  });
}

test("Campaign Orchestrator - buildCampaignFromStrategy drafting", async () => {
  const strategyId = `strat_test_${Date.now()}`;
  const businessId = "biz_test_1";
  await seedTestStrategy(strategyId, businessId);

  const campaign = await buildCampaignFromStrategy(strategyId, "Test Promo Campaign", 10000);

  assert.strictEqual(campaign.name, "Test Promo Campaign");
  assert.strictEqual(campaign.status, "draft");
  assert.strictEqual(campaign.dailyBudgetCents, 10000);
  // The seeded strategy recommends meta+google+tiktok, but TikTok is "coming soon": the builder
  // drops non-active networks (config/platforms.ts), so only meta+google variants are built.
  assert.strictEqual(campaign.variants.length, 4, "Should generate 4 variants (2 active networks x 2 creatives — TikTok dropped)");
  assert.ok(!campaign.variants.some(v => v.network === "tiktok"), "TikTok is coming-soon and must not be built into a variant");
  assert.deepStrictEqual(campaign.networks, ["meta", "google"], "campaign.networks reflects only launchable networks");

  const googleVariants = campaign.variants.filter(v => v.network === "google");
  assert.strictEqual(googleVariants.length, 2, "Should have 2 Google variants");
});

test("Campaign Orchestrator - buildCampaignFromStrategy threads the chosen objective onto the campaign", async () => {
  const strategyId = `strat_obj_${Date.now()}`;
  const businessId = "biz_test_obj";
  await seedTestStrategy(strategyId, businessId);

  const withObjective = await buildCampaignFromStrategy(strategyId, "Objective Campaign", 10000, "OUTCOME_LEADS");
  assert.strictEqual(withObjective.objective, "OUTCOME_LEADS", "objective should be stamped onto the campaign");

  // Omitting the objective leaves it undefined (launch falls back to the historical default).
  const withoutObjective = await buildCampaignFromStrategy(strategyId, "No Objective Campaign", 10000);
  assert.strictEqual(withoutObjective.objective, undefined, "objective should be undefined when not provided");
});

test("Campaign Orchestrator - launchCampaign and pauseVariant execution flow", async () => {
  const strategyId = `strat_test_${Date.now()}`;
  const businessId = "biz_test_1";
  await seedTestStrategy(strategyId, businessId);

  const campaignDraft = await buildCampaignFromStrategy(strategyId, "Launch Test Campaign", 20000);

  // Launch campaign
  const launched = await launchCampaign(campaignDraft.id);
  // Meta and Google launch through their real object-graph hierarchy, paused by default (safety
  // default — see launchMetaHierarchy/launchGoogleHierarchy). The builder already dropped the
  // strategy's TikTok recommendation (coming soon), so only Meta+Google variants exist and the
  // campaign is "paused" overall.
  assert.strictEqual(launched.status, "paused", "Campaign is paused overall (Meta/Google launch paused)");
  const launchedVariants = launched.variants.filter(v => v.network === "meta" || v.network === "google");
  assert.ok(launchedVariants.every(v => v.externalId), "All launched (Meta/Google) variants should be assigned external IDs");
  assert.ok(!launched.variants.some(v => v.network === "tiktok"), "No TikTok variant is built (coming soon)");

  // Pause a launched variant
  const targetVariant = launchedVariants[0];
  const pausedCampaign = await pauseVariant(launched.id, targetVariant.id);
  const pausedVariant = pausedCampaign.variants.find(v => v.id === targetVariant.id);

  assert.strictEqual(pausedVariant?.status, "paused", "Target variant should change to paused");
});

test("Campaign Orchestrator - Meta and Google variants launch through their hierarchy paths as paused (mock mode)", async () => {
  const strategyId = `strat_test_${Date.now()}`;
  const businessId = "biz_test_1";
  await seedTestStrategy(strategyId, businessId);

  const campaignDraft = await buildCampaignFromStrategy(strategyId, "Hierarchy Test Campaign", 30000);
  const launched = await launchCampaign(campaignDraft.id, "demo");

  const metaVariants = launched.variants.filter(v => v.network === "meta");
  const googleVariants = launched.variants.filter(v => v.network === "google");
  assert.ok(metaVariants.length > 0, "Test strategy should produce at least one meta variant");
  assert.ok(googleVariants.length > 0, "Test strategy should produce at least one google variant");

  for (const variant of [...metaVariants, ...googleVariants]) {
    assert.strictEqual(variant.status, "paused", `${variant.network} variants should launch paused by default (safety default)`);
    assert.ok(variant.externalId, `${variant.network} variant should get a mock ad id`);
    assert.ok(variant.adSetExternalId, `${variant.network} variant should be attached to a mock ad set/ad group id`);
  }

  assert.ok(!launched.variants.some(v => v.network === "tiktok"), "TikTok is coming-soon: the builder must not produce a TikTok variant");
  assert.strictEqual(launched.status, "paused", "Campaign is paused overall (Meta/Google paused — no active variant)");
});

test("Campaign Orchestrator - launchCampaign skips a stray non-active variant instead of failing the campaign (direct-launch guard)", async () => {
  // The builders drop coming-soon networks, but launchCampaign is also reachable via
  // POST /campaigns/:id/launch on an arbitrary persisted campaign — e.g. an older draft built
  // before TikTok was gated. This asserts the last-resort skip loop still protects that path:
  // the TikTok variant is marked "skipped" (no adapter call, no externalId) and does NOT drag the
  // campaign to "failed"; Meta still launches paused.
  const strategyId = `strat_stray_${Date.now()}`;
  const businessId = "biz_test_stray";
  await seedTestStrategy(strategyId, businessId);
  const draft = await buildCampaignFromStrategy(strategyId, "Stray Variant Campaign", 20000);

  // Inject a stray TikTok variant directly (bypassing the builder) to simulate a legacy draft.
  draft.variants.push({
    id: `stray_tiktok_${Date.now()}`,
    creative: { headline: "Legacy", body: "Legacy body", callToAction: "Learn More" },
    network: "tiktok",
    status: "draft",
    audienceName: "General Audience",
    landingPageUrl: "https://example.com/",
  });
  await saveCampaign(draft);

  const launched = await launchCampaign(draft.id, "demo");
  const tiktok = launched.variants.find(v => v.network === "tiktok")!;
  assert.strictEqual(tiktok.status, "skipped", "stray TikTok variant is skipped, not launched");
  assert.ok(!tiktok.externalId, "skipped TikTok variant never gets an external id");
  assert.ok(!launched.networks.includes("tiktok"), "skipped TikTok network is not reported as a live network");
  assert.notStrictEqual(launched.status, "failed", "a stray coming-soon variant must not fail the whole campaign");
});

test("Campaign Orchestrator - launchCampaign is idempotent: a re-launch reuses the Meta container and variant ids (no duplicate spend)", async () => {
  // launchCampaign blocks 30s–2min synchronously, so a retry/double-click is likely — it must NOT
  // build a second Meta campaign/ad/graph (which would spend twice). Re-launching a fully-launched
  // campaign must return the SAME externalIds it already had.
  const strategyId = `strat_idem_${Date.now()}`;
  const businessId = "biz_test_idem";
  await seedTestStrategy(strategyId, businessId);
  const draft = await buildCampaignFromStrategy(strategyId, "Idempotency Campaign", 20000);

  const first = await launchCampaign(draft.id, "demo");
  const firstMetaContainer = first.externalIds?.meta;
  const firstVariantIds = first.variants.filter(v => v.network === "meta").map(v => v.externalId);
  assert.ok(firstMetaContainer, "first launch should create a Meta campaign container id");
  assert.ok(firstVariantIds.every(Boolean), "first launch should assign every Meta variant an external id");

  const second = await launchCampaign(draft.id, "demo");
  const secondMetaContainer = second.externalIds?.meta;
  const secondVariantIds = second.variants.filter(v => v.network === "meta").map(v => v.externalId);

  assert.strictEqual(secondMetaContainer, firstMetaContainer, "re-launch must REUSE the existing Meta campaign container, not mint a new one");
  assert.deepStrictEqual(secondVariantIds, firstVariantIds, "re-launch must keep the same variant ad ids (no duplicate ads created)");
});

test("Campaign Orchestrator - buildCampaignFromStrategy applies each network's real copy limits to its own variant, not one shared truncation", async () => {
  const strategyId = `strat_test_${Date.now()}`;
  const businessId = "biz_test_1";
  const longHeadline = "This headline is written to be much longer than any single ad network's real character limit";
  const longBody = "This is a deliberately long piece of ad body copy, written to run well past even Meta's 125-character primary-text allowance so every network's truncation can be verified independently of the others in this same test.";

  await prisma.strategy.upsert({
    where: { id: strategyId },
    create: {
      id: strategyId,
      businessId,
      data: {
        id: strategyId,
        businessId,
        summary: "Test strategy overview",
        recommendedNetworks: ["meta", "google", "tiktok"],
        budgetSplit: { meta: 0.34, google: 0.33, tiktok: 0.33 },
        audiences: ["Custom Lookalike"],
        creatives: [{ headline: longHeadline, body: longBody, callToAction: "Learn More" }],
        createdAt: new Date().toISOString(),
      },
      createdAt: new Date(),
    },
    update: {},
  });

  const campaign = await buildCampaignFromStrategy(strategyId, "Copy Limits Test Campaign", 10000);

  // TikTok is "coming soon" and dropped by the builder, so only the two active networks are
  // present — per-network truncation is verified between Meta and Google.
  const meta = campaign.variants.find((v) => v.network === "meta")!;
  const google = campaign.variants.find((v) => v.network === "google")!;
  assert.ok(!campaign.variants.some((v) => v.network === "tiktok"), "TikTok variant must not be built (coming soon)");

  assert.ok(meta.creative.headline.length <= 40, `meta headline should be <= 40 chars, got ${meta.creative.headline.length}`);
  assert.ok(google.creative.headline.length <= 30, `google headline should be <= 30 chars, got ${google.creative.headline.length}`);
  assert.notStrictEqual(meta.creative.headline, google.creative.headline, "the same source headline must be truncated differently per network, not shared verbatim");

  assert.ok(meta.creative.body.length <= 125);
  assert.ok(google.creative.body.length <= 90);
});

test("Campaign Orchestrator - activateVariant flips a launched Meta variant to active", async () => {
  const strategyId = `strat_test_${Date.now()}`;
  const businessId = "biz_test_1";
  await seedTestStrategy(strategyId, businessId);

  const campaignDraft = await buildCampaignFromStrategy(strategyId, "Activate Test Campaign", 30000);
  const launched = await launchCampaign(campaignDraft.id, "demo");
  const metaVariant = launched.variants.find(v => v.network === "meta")!;

  const activated = await activateVariant(launched.id, metaVariant.id);
  const activatedVariant = activated.variants.find(v => v.id === metaVariant.id);
  assert.strictEqual(activatedVariant?.status, "active");
});

test("Campaign Orchestrator - activateVariant activates the full Meta chain parent-first (campaign → ad set → ad)", async () => {
  const strategyId = `strat_chain_${Date.now()}`;
  const businessId = "biz_test_chain";
  await seedTestStrategy(strategyId, businessId);

  const campaignDraft = await buildCampaignFromStrategy(strategyId, "Chain Activate Campaign", 30000);
  const launched = await launchCampaign(campaignDraft.id, "demo");
  const metaVariant = launched.variants.find(v => v.network === "meta" && v.externalId)!;
  // The hierarchy launch mints all three container ids in mock mode — the chain fix relies on them.
  assert.ok(launched.externalIds?.meta, "launch should record the Meta campaign container id");
  assert.ok(metaVariant.adSetExternalId, "launched Meta variant should carry its ad set id");

  // Meta won't spend unless campaign + ad set + ad are ALL active, and the parent must never be
  // paused when the child goes live — so assert activateVariant calls the adapter once per chain
  // level, in campaign → ad set → ad order, with the ids the launch path stored.
  const calls: string[] = [];
  const spy = mock.method(metaAdapter, "activateVariant", async (id: string) => { calls.push(id); });
  try {
    await activateVariant(launched.id, metaVariant.id);
  } finally {
    spy.mock.restore();
  }

  assert.deepStrictEqual(
    calls,
    [launched.externalIds!.meta, metaVariant.adSetExternalId, metaVariant.externalId],
    "should activate campaign, then ad set, then ad — parent-first",
  );
});

test("Campaign Orchestrator - applyCreativeMedia attaches generated image/video to variants lacking one", async () => {
  const strategyId = `strat_test_${Date.now()}`;
  const businessId = "biz_test_1";
  await seedTestStrategy(strategyId, businessId);

  const campaignDraft = await buildCampaignFromStrategy(strategyId, "Media Test Campaign", 10000);
  const updated = await applyCreativeMedia(campaignDraft.id, { imageUrl: "/objects/demo/hero.png" });

  assert.ok(updated.variants.every(v => v.creative.imageUrl === "/objects/demo/hero.png"));
});
