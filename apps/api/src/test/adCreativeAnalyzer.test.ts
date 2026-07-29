import { test, after } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { disconnectTestInfra } from "./testUtils/disconnectInfra.js";

after(disconnectTestInfra);

// llmClient.ts's `llm` export (geminiClient.ts's gate) is computed once at module load from
// GEMINI_API_KEY — a static top-level import would be hoisted ahead of the deletes
// below and always see whatever real key happens to be loaded (several earlier-running test
// files in this same `npm test` process load dotenv/config, e.g. memoryCoordinator.test.ts,
// which pulls the real apps/api/.env GEMINI_API_KEY into process.env for the rest of
// the process). A cache-busted dynamic import, run AFTER the deletes, is this codebase's
// established way to guarantee a genuinely-unconfigured client (see audienceIntelligenceEngine.test.ts).
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
const t = Date.now();
const { analyzeAdCreative, analyzeNewCompetitorAds } = await import(`../research/creative-intelligence/AdCreativeAnalyzer.js?t=${t}`);

// Deleting the Gemini key can be load-order-fragile (an earlier test file in the same `npm test`
// process may have already frozen llmClient.ts's `llm` gate with a real key). To force the
// fallback path deterministically we ALSO stub global.fetch to reject: the Gemini HTTP call
// fails, runStructured returns null, and analyzeAdCreative deterministically hits fallbackFields()
// regardless of keys/load order. (Same "no network → labeled fallback" approach as
// audienceIntelligenceEngine.test.ts.)
async function withNoNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const original = global.fetch;
  global.fetch = (async () => { throw new Error("network disabled in test"); }) as typeof fetch;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

test("analyzeAdCreative - with no LLM provider configured, degrades to a labeled low-confidence fallback", async () => {
  const result: any = await withNoNetwork(() =>
    analyzeAdCreative({ id: "ad-1", platform: "meta", headline: "Big Sale", description: "50% off", cta: null, landingPageUrl: null }));
  assert.strictEqual(result.confidence, 0.1);
  assert.match(result.hook, /no live analysis performed/);
});

test("analyzeAdCreative - an ad with no headline/description gets the same fallback confidence as one with content when there's no API key", async () => {
  const empty: any = await withNoNetwork(() =>
    analyzeAdCreative({ id: "ad-1", platform: "meta", headline: null, description: null, cta: null, landingPageUrl: null }));
  assert.strictEqual(empty.confidence, 0.1);
});

async function createFixtureCompetitorWithAds(): Promise<{ businessId: string; competitorId: string; adWithContentId: string; adWithoutContentId: string }> {
  const businessId = randomUUID();
  const competitorId = randomUUID();
  await prisma.business.create({ data: { id: businessId, data: { id: businessId, name: "Fixture Co" } as any } });
  await prisma.competitor.create({ data: { id: competitorId, businessId, workspaceId: randomUUID(), name: "Rival Co", discoverySources: [] } });

  const adWithContentId = randomUUID();
  const adWithoutContentId = randomUUID();
  await prisma.competitorAd.create({
    data: { id: adWithContentId, competitorId, platform: "meta", externalAdId: "ad-1", headline: "Big Sale", description: "50% off today", rawSourceData: {}, estimatedCountries: [] },
  });
  await prisma.competitorAd.create({
    data: { id: adWithoutContentId, competitorId, platform: "google", externalAdId: "ad-2", rawSourceData: {}, estimatedCountries: [] },
  });
  return { businessId, competitorId, adWithContentId, adWithoutContentId };
}

async function cleanup(businessId: string, competitorId: string): Promise<void> {
  await prisma.adCreativeAnalysis.deleteMany({ where: { competitorAd: { competitorId } } });
  await prisma.competitorAd.deleteMany({ where: { competitorId } });
  await prisma.competitor.delete({ where: { id: competitorId } }).catch(() => {});
  await prisma.business.delete({ where: { id: businessId } }).catch(() => {});
}

test("analyzeNewCompetitorAds - analyzes every ad lacking a creative-analysis row and persists the result", async () => {
  const { businessId, competitorId, adWithContentId } = await createFixtureCompetitorWithAds();
  try {
    const analyzed = await withNoNetwork(() => analyzeNewCompetitorAds(competitorId));
    assert.strictEqual(analyzed, 2, "expected both ads (with and without content) to be analyzed");

    const analysis = await prisma.adCreativeAnalysis.findUnique({ where: { competitorAdId: adWithContentId } });
    assert.ok(analysis, "expected an AdCreativeAnalysis row for the ad with content");
    assert.strictEqual(analysis?.confidence, 0.1, "network disabled in test — expect the labeled fallback");
  } finally {
    await cleanup(businessId, competitorId);
  }
});

test("analyzeNewCompetitorAds - skips ads that already have a creative-analysis row (no duplicate rows)", async () => {
  const { businessId, competitorId, adWithContentId } = await createFixtureCompetitorWithAds();
  try {
    await analyzeNewCompetitorAds(competitorId);
    const secondPass = await analyzeNewCompetitorAds(competitorId);
    assert.strictEqual(secondPass, 0, "expected zero new analyses since both ads already have one");

    const count = await prisma.adCreativeAnalysis.count({ where: { competitorAdId: adWithContentId } });
    assert.strictEqual(count, 1);
  } finally {
    await cleanup(businessId, competitorId);
  }
});
