import { randomUUID } from "node:crypto";
import { objectStorage } from "../../infra/objectStorage.js";
import { createAsset } from "../assets/assetService.js";
import { getCampaign, updateCampaign } from "../orchestrator/campaignOrchestrator.js";
import { getStrategy } from "../strategy/strategyEngine.js";
import { logger } from "../logger/logger.js";
import type { CreativeAssetRef } from "../../types/index.js";
import type { ResearchContext } from "../../research/types/index.js";
import { generateVectorAdImageSet, vectorAdContextFrom, type VectorAdContext, type VectorAdVariant } from "./vectorAdImageService.js";

// The async job that turns a completed campaign into a SET of grounded vector (SVG) ad creatives:
// generate via Claude/Bedrock -> upload each SVG to object storage -> persist as an Asset -> attach
// to the campaign's creativeAssets (merged, capped at 10). Enqueued best-effort by the campaign-
// generation pipeline and run by workers/vectorAdGenerationWorker.ts. Kept entirely off the campaign
// build's critical path: if this fails, the campaign is unaffected — it just has no auto-generated
// vector creatives yet.

/** BullMQ payload for the vector-ad-generation queue — everything the job needs to build a grounded set. */
export interface VectorAdGenerationJobData {
  workspaceId: string;
  businessId: string;
  campaignId: string;
  strategyId: string;
  /** How many variants to generate (floored at 4 by generateVectorAdImageSet). */
  count?: number;
  /** Grounded context, resolved by the enqueuer from the ResearchContext + strategy so the worker
   * doesn't have to reload research. Optional: if absent, the worker rebuilds it from the campaign's
   * strategy alone (thinner, but never blocks on research availability). */
  context?: VectorAdContext;
}

async function uploadSvg(workspaceId: string, svg: Buffer): Promise<string> {
  const key = `${workspaceId}/generated/${randomUUID()}.svg`;
  const { url } = await objectStorage.put(key, svg, "image/svg+xml");
  return url;
}

/** Persist one generated variant as an Asset and return the CreativeAssetRef that points at it. */
async function persistVariant(workspaceId: string, brand: string, variant: VectorAdVariant): Promise<CreativeAssetRef> {
  const url = await uploadSvg(workspaceId, variant.image.buffer);
  const asset = await createAsset(workspaceId, {
    name: `${brand} — vector ad (${variant.angle}, ${variant.aspectRatio})`,
    type: "image",
    url,
    size: variant.image.buffer.length,
    mimeType: variant.image.mimeType,
    tags: ["ai-generated", "vector", "bedrock-claude", `angle:${variant.angle}`, `aspect:${variant.aspectRatio}`],
  });
  return { id: asset.id, url, type: "image", source: "ai" };
}

/** Derive the grounded context from a strategy when the pipeline didn't pass one through. */
async function contextFromStrategy(strategyId: string): Promise<VectorAdContext | null> {
  const strategy = await getStrategy(strategyId);
  if (!strategy) return null;
  return vectorAdContextFrom({
    strategy: { summary: strategy.summary, creatives: strategy.creatives },
    // audiences[] are strings on AdStrategy; use the first as the primary audience.
    research: strategy.audiences?.length ? { audience: { primaryAudience: strategy.audiences[0] } } : {},
  });
}

/**
 * Run one queued vector-ad-generation job end to end. Generates at least `count` (default 4) grounded
 * SVG creatives, persists each as an Asset, and attaches them to the campaign's creativeAssets
 * (merged with any existing refs, capped at 10 by updateCampaign). Best-effort per variant — a partial
 * set still attaches. Returns the refs attached (empty if nothing could be generated).
 */
export async function runVectorAdGenerationJob(data: VectorAdGenerationJobData): Promise<CreativeAssetRef[]> {
  const context = data.context ?? (await contextFromStrategy(data.strategyId));
  if (!context) {
    logger.warn(`vectorAdGenerationJob: no context for campaign ${data.campaignId} (strategy ${data.strategyId}) — skipping`);
    return [];
  }

  const campaign = await getCampaign(data.campaignId);
  if (!campaign) throw new Error(`Campaign ${data.campaignId} not found for vector ad generation`);

  const variants = await generateVectorAdImageSet(context, data.count ?? 4);
  const refs: CreativeAssetRef[] = [];
  for (const variant of variants) {
    try {
      refs.push(await persistVariant(data.workspaceId, context.brand, variant));
    } catch (err) {
      logger.warn(`vectorAdGenerationJob: failed to persist variant ${variant.index} for campaign ${data.campaignId}`, err);
    }
  }

  if (refs.length === 0) {
    logger.warn(`vectorAdGenerationJob: generated 0 usable variants for campaign ${data.campaignId}`);
    return [];
  }

  // Merge with any existing creativeAssets rather than clobber (updateCampaign REPLACES the array).
  const merged = [...(campaign.creativeAssets ?? []), ...refs];

  // ── Assign the generated creatives to the ADS themselves. ──
  // Attaching them to campaign.creativeAssets alone was not enough: nothing anywhere set
  // variant.creative.imageUrl, so every generated campaign arrived with a creative library the ads
  // did not actually use. Meta rejects a link/video ad with no visual, so those campaigns were
  // unpublishable until a user hand-picked an image for each ad one at a time — and the Graph error
  // for it ("Invalid image format ... the image that you have uploaded") named an upload nobody made.
  //
  // Round-robin so several ads don't all get variant #1, and only ever FILL A GAP: an ad that
  // already has an image (a manual upload, or a previous assignment) is never overwritten.
  const imageRefs = refs.filter((r) => r.type === "image");
  let assigned = 0;
  const variantsWithImages = (campaign.variants ?? []).map((variant, index) => {
    if (variant.creative?.imageUrl || variant.creative?.videoUrl) return variant;
    const ref = imageRefs[assigned % imageRefs.length];
    if (!ref) return variant;
    assigned += 1;
    return { ...variant, creative: { ...variant.creative, imageUrl: ref.url } };
  });

  await updateCampaign(data.campaignId, {
    creativeAssets: merged,
    ...(assigned > 0 ? { variants: variantsWithImages } : {}),
  });
  logger.info(
    `vectorAdGenerationJob: attached ${refs.length} vector creatives to campaign ${data.campaignId}` +
      ` and assigned images to ${assigned} of ${(campaign.variants ?? []).length} ad(s)`
  );
  return refs;
}

/**
 * Build the job payload from the pipeline's in-hand objects. Called by campaignGenerationPipeline at
 * its tail to enqueue image generation without the worker having to reload research.
 */
export function vectorAdJobDataFrom(input: {
  workspaceId: string;
  businessId: string;
  campaignId: string;
  strategyId: string;
  research: ResearchContext;
  strategy: { summary?: string; creatives?: { headline?: string; callToAction?: string }[] };
  valueProps?: string[];
  count?: number;
}): VectorAdGenerationJobData {
  const context = vectorAdContextFrom({
    research: {
      company: input.research.company ? { name: input.research.company.name, summary: input.research.company.summary } : null,
      audience: input.research.audience ? { primaryAudience: input.research.audience.primaryAudience } : null,
    },
    strategy: input.strategy,
    valueProps: input.valueProps,
  });
  return {
    workspaceId: input.workspaceId,
    businessId: input.businessId,
    campaignId: input.campaignId,
    strategyId: input.strategyId,
    count: input.count,
    context,
  };
}
