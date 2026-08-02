import { test, after } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { disconnectTestInfra } from "./testUtils/disconnectInfra.js";
import { analyticsStore } from "../infra/analyticsStore.js";

for (const key of [
  "META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID",
  "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ADS_ACCESS_TOKEN",
  "TIKTOK_ACCESS_TOKEN", "TIKTOK_ADVERTISER_ID",
]) delete process.env[key];

const { buildCampaignFromStrategy, saveCampaign } = await import("../modules/orchestrator/campaignOrchestrator.js");
const { recordPerformanceSnapshot } = await import("../research/decision/campaign-intelligence-store.js");

after(disconnectTestInfra);

/**
 * Snapshots are cross-campaign LEARNING data keyed by workspace, so recordPerformanceSnapshot skips
 * any campaign it cannot attribute rather than folding one tenant's numbers into another's
 * benchmarks (campaign-intelligence-store.ts). buildCampaignFromStrategy does not set workspaceId —
 * only launchCampaign does — so a campaign built straight from a strategy is unattributable and
 * every snapshot assertion below was silently testing the skip path instead of the write path.
 * Attaching the workspace is what a launched campaign carries, and what these tests meant all along.
 */
async function attachWorkspace(campaign: Awaited<ReturnType<typeof buildCampaignFromStrategy>>, workspaceId: string) {
  campaign.workspaceId = workspaceId;
  await saveCampaign(campaign);
  return campaign;
}

async function seedStrategyAndCampaign(businessId: string): Promise<string> {
  const strategyId = `strat_snapshot_test_${Date.now()}_${Math.random()}`;
  const strategyData = {
    id: strategyId,
    businessId,
    summary: "Snapshot test strategy",
    recommendedNetworks: ["meta", "google"],
    budgetSplit: { meta: 0.5, google: 0.5 },
    audiences: ["Custom Lookalike"],
    creatives: [{ headline: "Snapshot Headline", body: "Snapshot body copy", callToAction: "Shop Now" }],
    createdAt: new Date().toISOString(),
  };
  await prisma.strategy.create({ data: { id: strategyId, businessId, data: strategyData, createdAt: new Date() } });
  const campaign = await buildCampaignFromStrategy(strategyId, "Snapshot Test Campaign", 5000);
  // Attributable, so the "no metrics" case below proves the no-metrics branch rather than passing
  // because the campaign had no workspace either.
  await attachWorkspace(campaign, `ws_snapshot_${Date.now()}`);
  return campaign.id;
}

test("recordPerformanceSnapshot - no-ops when a campaign has no metrics at all", async () => {
  const campaignId = await seedStrategyAndCampaign(`biz_snapshot_empty_${Date.now()}`);
  await recordPerformanceSnapshot(campaignId);
  const snapshot = await prisma.campaignPerformanceSnapshot.findFirst({ where: { campaignId } });
  assert.strictEqual(snapshot, null);
});

test("recordPerformanceSnapshot - writes a real aggregated snapshot from real metrics across two networks", async () => {
  const businessId = `biz_snapshot_real_${Date.now()}`;
  const strategyId = `strat_snapshot_real_${Date.now()}_${Math.random()}`;
  const strategyData = {
    id: strategyId, businessId, summary: "Snapshot test strategy", recommendedNetworks: ["meta", "google"],
    budgetSplit: { meta: 0.5, google: 0.5 }, audiences: ["Custom Lookalike"],
    creatives: [{ headline: "Snapshot Headline", body: "Snapshot body copy", callToAction: "Shop Now" }], createdAt: new Date().toISOString(),
  };
  await prisma.strategy.create({ data: { id: strategyId, businessId, data: strategyData, createdAt: new Date() } });
  const campaign = await buildCampaignFromStrategy(strategyId, "Snapshot Test Campaign", 5000);
  await attachWorkspace(campaign, `ws_snapshot_real_${Date.now()}`);
  const campaignId = campaign.id;
  const metaVariant = campaign.variants.find((v) => v.network === "meta")!;
  const googleVariant = campaign.variants.find((v) => v.network === "google")!;

  await analyticsStore.recordMetric({
    id: randomUUID(), campaignId, variantId: metaVariant.id, network: "meta",
    date: new Date().toISOString().slice(0, 10), impressions: 5000, reach: 2500, clicks: 200, conversions: 20, spendCents: 10000, revenueCents: 40000,
  });
  await analyticsStore.recordMetric({
    id: randomUUID(), campaignId, variantId: googleVariant.id, network: "google",
    date: new Date().toISOString().slice(0, 10), impressions: 3000, reach: 1500, clicks: 100, conversions: 5, spendCents: 8000, revenueCents: 14000,
  });

  await recordPerformanceSnapshot(campaignId);

  const snapshot = await prisma.campaignPerformanceSnapshot.findFirst({ where: { campaignId }, orderBy: { capturedAt: "desc" } });
  assert.ok(snapshot, "expected a real snapshot row to be written");
  assert.strictEqual(snapshot!.campaignId, campaignId);
  assert.strictEqual(snapshot!.businessId, businessId);
  assert.strictEqual(snapshot!.impressions, 8000, "5000 + 3000 across both networks");
  assert.strictEqual(snapshot!.clicks, 300);
  assert.strictEqual(snapshot!.conversions, 25);
  assert.strictEqual(snapshot!.spendCents, 18000);
  assert.strictEqual(snapshot!.revenueCents, 54000, "40000 + 14000 real reported revenue across both networks");
  assert.strictEqual(snapshot!.roas, 3, "true ROAS = 54000 revenue / 18000 spend");
  assert.strictEqual(snapshot!.platform, null, "spans two distinct networks, so no single platform is denormalized");

  const breakdown = (snapshot!.metadata as any).networkBreakdown as { network: string; conversions: number }[];
  assert.strictEqual(breakdown.length, 2, "expected one breakdown entry per network");
  assert.ok(breakdown.find((b) => b.network === "meta" && b.conversions === 20));
  assert.ok(breakdown.find((b) => b.network === "google" && b.conversions === 5));
});

test("recordPerformanceSnapshot - denormalizes a single platform when every variant shares one network", async () => {
  const businessId = `biz_snapshot_single_${Date.now()}`;
  const strategyId = `strat_snapshot_single_${Date.now()}_${Math.random()}`;
  const strategyData = {
    id: strategyId, businessId, summary: "Single network", recommendedNetworks: ["meta"], budgetSplit: { meta: 1 },
    audiences: ["Audience"], creatives: [{ headline: "H", body: "B", callToAction: "Go" }], createdAt: new Date().toISOString(),
  };
  await prisma.strategy.create({ data: { id: strategyId, businessId, data: strategyData, createdAt: new Date() } });
  const campaign = await buildCampaignFromStrategy(strategyId, "Single Network Campaign", 5000);
  await attachWorkspace(campaign, `ws_snapshot_single_${Date.now()}`);
  const variant = campaign.variants.find((v) => v.network === "meta")!;

  await analyticsStore.recordMetric({
    id: randomUUID(), campaignId: campaign.id, variantId: variant.id, network: "meta",
    date: new Date().toISOString().slice(0, 10), impressions: 1000, reach: 900, clicks: 40, conversions: 6, spendCents: 3000, revenueCents: 9000,
  });

  await recordPerformanceSnapshot(campaign.id);
  const snapshot = await prisma.campaignPerformanceSnapshot.findFirst({ where: { campaignId: campaign.id } });
  assert.strictEqual(snapshot!.platform, "meta");
});
