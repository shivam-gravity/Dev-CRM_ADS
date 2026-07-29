import { test, before, after } from "node:test";
import assert from "node:assert";

// Force the deterministic, network-free paths: no Gemini (so brief generation uses the
// angle-diverse fallback set) and no image keys (so getImageProvider returns the always-succeeds
// in-process MockImageProvider). Cleared before the first import of the service under test, since
// llmClient reads GEMINI_API_KEY once at module load.
for (const key of [
  "GEMINI_API_KEY", "IMAGE_GENERATION_ENABLED",
  "OPENAI_API_KEY", "STABILITY_API_KEY", "GEMINI_API_KEY", "RUNWAY_API_KEY",
]) delete process.env[key];

const { prisma } = await import("../db/prisma.js");
const { disconnectTestInfra } = await import("./testUtils/disconnectInfra.js");
const { runGenerationJob } = await import("../modules/generation/creativeGenerationService.js");
const { createGenerationJob, getGenerationJob } = await import("../modules/generation/generationJobService.js");

const workspaceId = "ws_creative_multiangle";
const businessId = "biz_creative_multiangle";

before(async () => {
  await prisma.business.upsert({
    where: { id: businessId },
    create: { id: businessId, workspaceId, data: { id: businessId, name: "Multi-Angle Test Co" } as any },
    update: {},
  });
});

after(disconnectTestInfra);

test("runGenerationJob produces an angle-diverse burst of distinct creatives by default", async () => {
  const job = await createGenerationJob(workspaceId, {
    businessId,
    prompt: "A productivity app that automates weekly reports for busy teams.",
    wantVideo: false,
    variantCount: 4,
  });

  await runGenerationJob(job.id);

  const done = await getGenerationJob(job.id);
  assert.strictEqual(done?.status, "done", "job should complete");
  const result = done!.result!;

  // The full burst is present and honored the requested count.
  assert.ok(Array.isArray(result.variants), "result should carry the multi-angle burst");
  assert.strictEqual(result.variants!.length, 4, "should produce 4 creatives");

  // Backward compatibility: top-level fields mirror the FIRST variant, so single-creative
  // consumers (fatigue swap, existing UI) keep working unchanged.
  const primary = result.variants![0];
  assert.strictEqual(result.creativeId, primary.creativeId);
  assert.strictEqual(result.headline, primary.headline);
  assert.strictEqual(result.imageUrl, primary.imageUrl);

  // Every creative is real: a persisted Creative row id + an uploaded image url.
  for (const v of result.variants!) {
    assert.ok(v.creativeId, "each variant has a persisted creative id");
    assert.ok(v.imageUrl, "each variant has an image url");
  }

  // Diversity is the whole point — the headlines must not be N copies of one.
  const uniqueHeadlines = new Set(result.variants!.map((v) => v.headline));
  assert.ok(uniqueHeadlines.size >= 2, "burst should contain genuinely distinct headlines, not duplicates");
});

test("a fatigue-refresh job stays single (one replacement for the swap)", async () => {
  const job = await createGenerationJob(workspaceId, {
    businessId,
    prompt: "Same product, fresh angle for a fatigued ad.",
    wantVideo: false,
    variantCount: 4, // even if a count leaks in, a fatigue-refresh must produce exactly one
    reason: "fatigue-refresh",
    campaignId: "camp_x",
    variantId: "var_x",
  });

  await runGenerationJob(job.id);

  const done = await getGenerationJob(job.id);
  assert.strictEqual(done?.status, "done");
  assert.strictEqual(done!.result!.variants!.length, 1, "fatigue-refresh must produce exactly one creative");
});
