import { test, after } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { disconnectTestInfra } from "./testUtils/disconnectInfra.js";
import { analyticsStore } from "../infra/analyticsStore.js";

// Same mock-mode safety as campaignOrchestrator.test.ts — cleared before the first import of
// campaignOrchestrator.js so this file never accidentally hits a real ad-network API.
for (const key of [
  "META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID",
  "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ADS_ACCESS_TOKEN",
  "TIKTOK_ACCESS_TOKEN", "TIKTOK_ADVERTISER_ID",
]) delete process.env[key];

const { buildCampaignFromStrategy, launchCampaign, activateVariant } = await import("../modules/orchestrator/campaignOrchestrator.js");
const { runOptimizationPass } = await import("../modules/optimization/optimizationEngine.js");

after(disconnectTestInfra);

async function seedTestStrategy(id: string, businessId: string) {
  const strategyData = {
    id,
    businessId,
    summary: "Fatigue test strategy",
    recommendedNetworks: ["meta"],
    budgetSplit: { meta: 1 },
    audiences: ["Custom Lookalike"],
    creatives: [{ headline: "Original Headline", body: "Original body copy", callToAction: "Shop Now" }],
    createdAt: new Date().toISOString(),
  };
  await prisma.strategy.upsert({
    where: { id },
    create: { id, businessId, data: strategyData, createdAt: new Date(strategyData.createdAt) },
    update: { data: strategyData },
  });
}

/** Launch a Meta variant (mock mode → paused by the safety default) and explicitly activate it,
 * so runOptimizationPass's `activeVariants` filter includes it. Previously this used TikTok, whose
 * mock launch defaulted to "active", but TikTok is now "coming soon"/skipped at launch — so we
 * activate a Meta variant instead to get the same active-variant precondition. */
async function launchTestCampaignWithActiveVariant(): Promise<{ campaignId: string; variantId: string; businessId: string }> {
  const strategyId = `strat_fatigue_test_${Date.now()}_${Math.random()}`;
  const businessId = "biz_test_1";
  await seedTestStrategy(strategyId, businessId);
  const draft = await buildCampaignFromStrategy(strategyId, "Fatigue Test Campaign", 10000);
  const launched = await launchCampaign(draft.id, "demo-fatigue-test");
  const variant = launched.variants.find((v) => v.network === "meta" && v.externalId);
  if (!variant) throw new Error("Expected a launched Meta variant in mock mode");
  await activateVariant(launched.id, variant.id);
  return { campaignId: launched.id, variantId: variant.id, businessId };
}

async function seedHighFrequencyMetrics(campaignId: string, variantId: string): Promise<void> {
  // impressions/reach = 4x — comfortably past FREQUENCY_FATIGUE_THRESHOLD (3.5x) on its own.
  await analyticsStore.recordMetric({
    id: randomUUID(),
    campaignId,
    variantId,
    network: "meta",
    date: new Date().toISOString().slice(0, 10),
    impressions: 8000,
    reach: 2000,
    clicks: 40,
    conversions: 1,
    spendCents: 4000,
    revenueCents: 5000,
  });
}

test("runOptimizationPass - a high-frequency (fatigued) variant gets a regenerate_creative decision and a real queued GenerationJob", async () => {
  const { campaignId, variantId, businessId } = await launchTestCampaignWithActiveVariant();
  await seedHighFrequencyMetrics(campaignId, variantId);

  const decisions = await runOptimizationPass(campaignId);

  const fatigueDecision = decisions.find((d) => d.chosenVariantId === variantId && d.action === "regenerate_creative");
  assert.ok(fatigueDecision, "expected a regenerate_creative decision for the fatigued variant");
  assert.match(fatigueDecision!.reason, /frequency/);

  const jobs = await prisma.generationJob.findMany({ where: { businessId } });
  const fatigueJob = jobs.find((j) => (j.input as any)?.variantId === variantId && (j.input as any)?.reason === "fatigue-refresh");
  assert.ok(fatigueJob, "expected a real GenerationJob row created for the fatigue refresh");
  assert.strictEqual(fatigueJob!.status, "queued");
});

test("runOptimizationPass - a fatigued variant does not trigger a second refresh within the cooldown window", async () => {
  const { campaignId, variantId, businessId } = await launchTestCampaignWithActiveVariant();
  await seedHighFrequencyMetrics(campaignId, variantId);

  const firstPass = await runOptimizationPass(campaignId);
  assert.ok(firstPass.some((d) => d.chosenVariantId === variantId && d.action === "regenerate_creative"));

  const secondPass = await runOptimizationPass(campaignId);
  assert.ok(
    !secondPass.some((d) => d.chosenVariantId === variantId && d.action === "regenerate_creative"),
    "a second immediate pass should not re-trigger a fatigue refresh for the same variant"
  );

  const jobs = await prisma.generationJob.findMany({ where: { businessId } });
  const fatigueJobs = jobs.filter((j) => (j.input as any)?.variantId === variantId && (j.input as any)?.reason === "fatigue-refresh");
  assert.strictEqual(fatigueJobs.length, 1, "exactly one fatigue-refresh job should exist, not one per pass");
});

test("runOptimizationPass - a variant with few recent conversions holds its budget (learning phase)", async () => {
  const { campaignId, variantId } = await launchTestCampaignWithActiveVariant();
  // Low, healthy-frequency delivery with only a handful of conversions — well under the 50/week
  // learning-phase threshold, so its budget must be held (not reallocated) to avoid resetting delivery.
  await analyticsStore.recordMetric({
    id: randomUUID(),
    campaignId,
    variantId,
    network: "meta",
    date: new Date().toISOString().slice(0, 10),
    impressions: 1200,
    reach: 1100,
    clicks: 30,
    conversions: 4,
    spendCents: 3000,
    revenueCents: 12000,
  });

  const decisions = await runOptimizationPass(campaignId);
  const decision = decisions.find((d) => d.chosenVariantId === variantId);
  assert.strictEqual(decision?.action, "hold", "a learning-phase variant should hold, not have its budget moved");
  assert.match(decision!.reason, /learning phase/i);
});

test("runOptimizationPass - a healthy (low-frequency, stable) variant never triggers a fatigue refresh", async () => {
  const { campaignId, variantId, businessId } = await launchTestCampaignWithActiveVariant();
  await analyticsStore.recordMetric({
    id: randomUUID(),
    campaignId,
    variantId,
    network: "meta",
    date: new Date().toISOString().slice(0, 10),
    impressions: 1000,
    reach: 950,
    clicks: 20,
    conversions: 2,
    spendCents: 3000,
    revenueCents: 9000,
  });

  const decisions = await runOptimizationPass(campaignId);
  assert.ok(!decisions.some((d) => d.chosenVariantId === variantId && d.action === "regenerate_creative"));

  const jobs = await prisma.generationJob.findMany({ where: { businessId } });
  assert.ok(!jobs.some((j) => (j.input as any)?.variantId === variantId && (j.input as any)?.reason === "fatigue-refresh"));
});
