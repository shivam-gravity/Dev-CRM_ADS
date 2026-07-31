import { getCampaign, saveCampaign } from "../orchestrator/campaignOrchestrator.js";
import { getMetaCredentials } from "../integrations/integrationService.js";
import { metaAdapter } from "../adapters/metaAdapter.js";
import { getGenerationJob } from "../generation/generationJobService.js";
import { logger } from "../logger/logger.js";

/**
 * Closes the creative-fatigue loop. Detection (creativeFatigueDetector) and regeneration
 * (optimizationEngine → creativeGenerationQueue) already run automatically, but before this the
 * freshly generated creative just landed "for review" — a human still had to swap it into the live
 * ad. That's the gap vs. AdsGo's "auto-rotate creative on fatigue". This module performs the swap:
 * the fatigued ad is paused and a NEW ad carrying the fresh creative is created in the SAME ad set,
 * so targeting/budget/optimization history on the ad set are preserved and only the creative rotates.
 *
 * Only Meta is wired today (the live hierarchy adapter). Google/others are skipped rather than
 * silently half-swapped. Best-effort and idempotent-ish: it no-ops if the variant isn't a launched
 * Meta ad or the job produced no usable creative, and never throws into the worker.
 */

export interface CreativeSwapResult {
  swapped: boolean;
  reason: string;
  oldExternalId?: string;
  newExternalId?: string;
}

/**
 * Swap the creative on a fatigued variant with the one produced by a completed fatigue-refresh
 * generation job. Called from the creative-generation worker when it finishes a job tagged
 * reason:"fatigue-refresh" that carries a campaignId + variantId.
 */
export async function swapFatiguedCreative(jobId: string): Promise<CreativeSwapResult> {
  const job = await getGenerationJob(jobId);
  if (!job) return { swapped: false, reason: "generation job not found" };
  if (job.input.reason !== "fatigue-refresh") return { swapped: false, reason: "not a fatigue-refresh job" };
  const { campaignId, variantId } = job.input;
  if (!campaignId || !variantId) return { swapped: false, reason: "job missing campaignId/variantId" };
  if (job.status !== "done" || !job.result?.creativeId) return { swapped: false, reason: "job has no completed creative" };

  const campaign = await getCampaign(campaignId);
  if (!campaign) return { swapped: false, reason: "campaign not found" };
  const variant = campaign.variants.find((v) => v.id === variantId);
  if (!variant) return { swapped: false, reason: "variant not found" };

  // Only rotate a variant that's actually live on Meta. Anything else (never launched, non-Meta,
  // already paused by a fuse/guardrail) is left alone — rotating it would fight another decision.
  if (variant.network !== "meta") return { swapped: false, reason: `network ${variant.network} not supported for auto-swap` };
  if (!variant.externalId || !variant.adSetExternalId) return { swapped: false, reason: "variant not launched (no ad/ad-set id)" };
  if (variant.status !== "active" && variant.status !== "paused") return { swapped: false, reason: `variant status ${variant.status} not swappable` };

  // The completed job's result already carries the fresh copy + media URLs — no need to re-fetch
  // the Creative row. (imageUrl/videoUrl on the result are the uploaded, ad-ready asset URLs.)
  const fresh = job.result;

  // A creative swap PAUSES a live ad and creates a replacement, so it must run against the right ad
  // account or not at all. The old `?? "demo"` would have done both operations on another tenant's
  // account; refusing is the only safe answer when the owner is unknown.
  if (!campaign.workspaceId) return { swapped: false, reason: "campaign has no workspace — cannot resolve which ad account to act on" };
  const credentials = (await getMetaCredentials(campaign.workspaceId)) ?? undefined;
  const oldExternalId = variant.externalId;
  const wasActive = variant.status === "active";

  try {
    // 1) Pause the fatigued ad so the stale creative stops serving immediately.
    await metaAdapter.pauseVariant(oldExternalId, credentials);

    // 2) Upload the fresh creative's media and create a NEW ad in the SAME ad set — the ad set
    //    (targeting/budget/learning) is untouched, only the creative rotates.
    const upload = await metaAdapter.uploadCreativeAsset!(
      { imageUrl: fresh.imageUrl, videoUrl: fresh.videoUrl },
      credentials,
    );
    const created = await metaAdapter.createHierarchyAd!(
      {
        adSetExternalId: variant.adSetExternalId,
        name: `${campaign.id}-${variant.id}-refresh`,
        creative: { headline: fresh.headline, body: fresh.body, callToAction: fresh.callToAction },
        landingPageUrl: variant.landingPageUrl ?? campaign.finalUrl ?? "https://example.com",
        imageHash: upload.imageHash,
        videoId: upload.videoId,
        instagramActorId: campaign.instagramAccountId,
      },
      credentials,
    );

    // 3) Point the variant at the new ad + creative. Preserve the prior run/pause state: if the
    //    fatigued ad was actively serving, activate the replacement so delivery continues; if it
    //    was paused, leave the replacement paused (created PAUSED by default) for review.
    if (wasActive) {
      await metaAdapter.activateVariant(created.externalId, credentials);
    }

    variant.creative = {
      ...variant.creative,
      headline: fresh.headline,
      body: fresh.body,
      callToAction: fresh.callToAction,
      imageUrl: fresh.imageUrl ?? variant.creative.imageUrl,
      videoUrl: fresh.videoUrl ?? variant.creative.videoUrl,
    };
    variant.externalId = created.externalId;
    variant.status = wasActive ? "active" : "paused";
    campaign.updatedAt = new Date().toISOString();
    await saveCampaign(campaign);

    logger.info(
      `creativeRotation: swapped fatigued creative on campaign ${campaignId} variant ${variantId} ` +
        `(old ad ${oldExternalId} paused, new ad ${created.externalId}, ${wasActive ? "active" : "paused"})`,
    );
    return { swapped: true, reason: "creative rotated", oldExternalId, newExternalId: created.externalId };
  } catch (err) {
    // Roll forward safely: the old ad is already paused. Don't leave delivery dark silently — log
    // loudly so the fatigued variant can be handled manually rather than the swap failing invisibly.
    logger.error(`creativeRotation: swap failed for campaign ${campaignId} variant ${variantId}`, err);
    return { swapped: false, reason: err instanceof Error ? err.message : String(err), oldExternalId };
  }
}
