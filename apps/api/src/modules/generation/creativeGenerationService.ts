import { llm, runStructured } from "../../infra/llmClient.js";
import { randomUUID } from "node:crypto";
import { objectStorage } from "../../infra/objectStorage.js";
import { createAsset } from "../assets/assetService.js";
import { createCreative } from "../orchestrator/creativesService.js";
import { scrapeUrl } from "../onboarding/scraper.js";
import { getImageProvider, isImageGenerationEnabled } from "./imageProvider.js";
import { generateVectorAdImage, isVectorImageGenerationEnabled, type VectorAdContext } from "./vectorAdImageService.js";
import { getBusiness } from "../business/businessService.js";
import { getVideoProvider } from "./videoProvider.js";
import {
  createGenerationJob,
  markGenerationJobDone,
  markGenerationJobFailed,
  markGenerationJobRunning,
  getGenerationJob,
  type GenerationJobInput,
  type GenerationJobResult,
  type GenerationCreativeVariant,
} from "./generationJobService.js";
import { logger } from "../logger/logger.js";

// How many distinct angle-diverse creatives a standalone "generate" produces by default, and the
// hard ceiling. Market performance is driven by testing MANY distinct angles (each a real arm for
// the optimization bandit), not one polished ad — so the default is a small burst, not a single
// creative. Env-tunable; a fatigue-refresh and any video job still produce exactly one.
export const DEFAULT_CREATIVE_VARIANTS = Math.max(1, Number(process.env.CREATIVE_VARIANTS_DEFAULT) || 4);
export const MAX_CREATIVE_VARIANTS = Math.max(DEFAULT_CREATIVE_VARIANTS, Number(process.env.CREATIVE_VARIANTS_MAX) || 8);

// A curated palette of distinct persuasion angles. The model is asked for N genuinely different
// concepts drawn from these (not N rephrasings of one) — diversity is the whole point, so the ad
// set spans the failure modes a single angle can't. Order = rough priority when N is small.
const CREATIVE_ANGLES = [
  "benefit-led (the core outcome/transformation)",
  "social proof (numbers, testimonials, popularity)",
  "problem–solution (name the pain, then resolve it)",
  "urgency / scarcity (limited time or supply)",
  "curiosity (an open loop that demands the click)",
  "authority / credibility (expertise, awards, data)",
  "UGC / testimonial voice (authentic first-person)",
  "objection-handling (defuse the top hesitation)",
];

const CREATIVE_BRIEF_SET_TOOL = {
  name: "emit_creative_briefs",
  description: "Return a SET of distinct ad creatives — each a different persuasion angle — with copy and an image-generation prompt per creative.",
  input_schema: {
    type: "object" as const,
    properties: {
      briefs: {
        type: "array",
        description: "One entry per requested creative; each MUST use a genuinely different angle, not a rephrasing.",
        items: {
          type: "object",
          properties: {
            angle: { type: "string", description: "The persuasion angle this creative uses (e.g. 'social proof', 'urgency')." },
            headline: { type: "string", description: "Attention-grabbing headline under 40 chars" },
            body: { type: "string", description: "Compelling ad body copy under 120 chars" },
            callToAction: { type: "string", description: "Short CTA text e.g. 'Shop Now', 'Learn More'" },
            imagePrompt: { type: "string", description: "A vivid, concrete prompt for an image generation model to produce a scroll-stopping ad hero image matching THIS creative's angle. Describe subject, setting, lighting, and mood — no text/typography in the image." },
          },
          required: ["angle", "headline", "body", "callToAction", "imagePrompt"],
        },
      },
    },
    required: ["briefs"],
  },
};

interface CreativeBrief {
  headline: string;
  body: string;
  callToAction: string;
  imagePrompt: string;
  /** The persuasion angle this concept uses — undefined on the legacy single-brief fallback. */
  angle?: string;
}

function fallbackBrief(context: string): CreativeBrief {
  return {
    headline: "Discover what everyone's talking about",
    body: `${context.slice(0, 90)}${context.length > 90 ? "…" : ""}`,
    callToAction: "Shop Now",
    imagePrompt: `A clean, bright product photography shot for an ad: ${context}`,
  };
}

/** Deterministic angle-diverse fallback when the LLM is unavailable — still gives the bandit
 * distinct arms rather than N copies. Mirrors creativesService.fallbackVariations' spirit. */
function fallbackBriefSet(context: string, count: number): CreativeBrief[] {
  const base = fallbackBrief(context);
  const snippet = context.slice(0, 80);
  const templates: CreativeBrief[] = [
    base,
    { headline: "Join thousands who already switched", body: `Trusted results, real people. ${snippet}`, callToAction: "Learn More", angle: "social proof", imagePrompt: `Happy customers using the product, candid lifestyle photography: ${context}` },
    { headline: "Tired of the old way?", body: `There's a better path. ${snippet}`, callToAction: "See How", angle: "problem–solution", imagePrompt: `A clean before/after style product hero shot: ${context}` },
    { headline: "Limited time — don't miss out", body: `Act now. ${snippet}`, callToAction: "Claim Now", angle: "urgency / scarcity", imagePrompt: `A bright, energetic product shot conveying momentum: ${context}` },
    { headline: "What if it were this easy?", body: `Imagine the result. ${snippet}`, callToAction: "Discover More", angle: "curiosity", imagePrompt: `An intriguing, minimal product close-up with dramatic lighting: ${context}` },
    { headline: "Backed by the numbers", body: `Proven, measurable outcomes. ${snippet}`, callToAction: "Get the Facts", angle: "authority / credibility", imagePrompt: `A precise, professional product shot on a clean studio background: ${context}` },
  ];
  return Array.from({ length: count }, (_, i) => templates[i % templates.length]);
}

/**
 * Ask the LLM for a SET of `count` genuinely distinct creative concepts (each its own angle, copy,
 * and image prompt) in ONE structured call — cheaper and more internally-diverse than N independent
 * single-brief calls, and it gives the optimization bandit real arms to test. Falls back to an
 * angle-diverse deterministic set (never N duplicates) when the LLM is unavailable or returns fewer
 * than requested.
 */
async function generateCreativeBriefSet(context: string, count: number, language?: string): Promise<CreativeBrief[]> {
  if (!llm) return fallbackBriefSet(context, count);

  const languageInstruction = language && language !== "English"
    ? ` Write each headline, body, and call to action in ${language} (the image prompts themselves should stay in English, since that's what the image model expects).`
    : "";

  const angleMenu = CREATIVE_ANGLES.slice(0, Math.max(count, 4)).map((a) => `- ${a}`).join("\n");
  const result = await runStructured<{ briefs: CreativeBrief[] }>({
    maxTokens: 2048,
    tool: CREATIVE_BRIEF_SET_TOOL,
    messages: [{
      role: "user",
      content: `Write ${count} DISTINCT ad creatives for this product/business. Each must use a genuinely different persuasion angle (draw from the list below — do not rephrase one idea ${count} times), so we can A/B test which angle the market responds to:
${angleMenu}

Product/business context:
${context}${languageInstruction}`,
    }],
  });

  const briefs = result?.briefs?.filter((b) => b?.headline && b?.body && b?.callToAction && b?.imagePrompt) ?? [];
  if (briefs.length === 0) return fallbackBriefSet(context, count);
  // Top up from the deterministic set if the model returned fewer than asked, so the caller always
  // gets exactly `count` arms.
  if (briefs.length < count) {
    const filler = fallbackBriefSet(context, count).slice(briefs.length);
    return [...briefs, ...filler].slice(0, count);
  }
  return briefs.slice(0, count);
}

async function resolveContext(input: GenerationJobInput): Promise<string> {
  if (input.prompt?.trim()) return input.prompt.trim();
  if (input.productUrl?.trim()) {
    try {
      const site = await scrapeUrl(input.productUrl.trim());
      return `${site.title}\n${site.description}\n${site.excerpt.slice(0, 1500)}`;
    } catch (err) {
      logger.warn(`Failed to scrape ${input.productUrl} for creative generation, falling back to raw URL`, err);
      return input.productUrl.trim();
    }
  }
  throw new Error("Either productUrl or prompt is required");
}

async function uploadGenerated(workspaceId: string, buffer: Buffer, mimeType: string, ext: string): Promise<string> {
  const key = `${workspaceId}/generated/${randomUUID()}.${ext}`;
  const { url } = await objectStorage.put(key, buffer, mimeType);
  return url;
}

/** MIME → file extension for the generated image (svg for the LLM vector path, else png/jpeg). */
function extForMime(mimeType: string): string {
  if (mimeType.includes("svg")) return "svg";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  return "png";
}

/** The grounded LLM vector (SVG) path — headline + CTA as crisp <text> on a brand palette. */
async function generateVectorCreativeImage(
  brief: CreativeBrief,
  businessId: string,
  context: string,
  aspectRatio: "square" | "portrait" | "landscape",
  quality?: "standard" | "high",
): Promise<{ buffer: Buffer; mimeType: string; ext: string }> {
  const business = await getBusiness(businessId).catch(() => null);
  const vectorContext: VectorAdContext = {
    brand: business?.brandName || business?.name || "the brand",
    positioning: business?.industry || context.slice(0, 200),
    audience: business?.targetAudience,
    headline: brief.headline,
    callToAction: brief.callToAction,
  };
  const { image } = await generateVectorAdImage(vectorContext, { aspectRatio, quality });
  return { buffer: image.buffer, mimeType: image.mimeType, ext: extForMime(image.mimeType) };
}

/**
 * Produce the ad image, RASTER-FIRST once image generation is opted in. Real photography (Google
 * Imagen → OpenAI → Stability → keyless Pollinations → placeholder) outperforms flat vector art on
 * the social feed, so it's the primary path; the grounded LLM-generated vector (SVG) is the
 * fallback if the raster chain throws.
 *
 * NOTE ON THE DEFAULT: image generation is NOT opted in for this deployment — ad creatives come
 * from MANUAL UPLOAD in the Campaign Builder. With no IMAGE_GENERATION_ENABLED / dedicated image
 * key, this falls to the grounded vector (SVG) when the LLM is configured, else the in-process
 * mock, so nothing here acquires a live image dependency by default. The whole chain stays wired so
 * adopting a generation model later is a config change rather than a code change.
 */
async function generateCreativeImage(
  brief: CreativeBrief,
  businessId: string,
  context: string,
  aspectRatio: "square" | "portrait" | "landscape",
  quality?: "standard" | "high",
): Promise<{ buffer: Buffer; mimeType: string; ext: string }> {
  if (isImageGenerationEnabled()) {
    try {
      const raster = await generateRasterImage(brief, aspectRatio, quality);
      if (raster.buffer.length > 0) return raster;
    } catch (err) {
      logger.warn("Raster image chain failed — falling back to LLM vector (SVG)", err);
    }
    // Raster degraded/failed — try the grounded vector before giving up.
    if (isVectorImageGenerationEnabled()) {
      try {
        return await generateVectorCreativeImage(brief, businessId, context, aspectRatio, quality);
      } catch (err) {
        logger.warn("LLM vector (SVG) fallback also failed", err);
      }
    }
    return generateRasterImage(brief, aspectRatio, quality); // placeholder tier — never blank
  }

  // Not opted into raster image generation: preserve the prior vector-first default.
  if (isVectorImageGenerationEnabled()) {
    try {
      return await generateVectorCreativeImage(brief, businessId, context, aspectRatio, quality);
    } catch (err) {
      logger.warn("LLM vector (SVG) generation failed — falling back to the raster image chain", err);
    }
  }
  return generateRasterImage(brief, aspectRatio, quality);
}

/** Raster (PNG/JPEG) image via the multi-provider chain (imageProvider.ts). Used for the video
 * flow (Runway animates a raster frame) and as the vector-generation fallback. */
async function generateRasterImage(
  brief: CreativeBrief,
  aspectRatio: "square" | "portrait" | "landscape",
  quality?: "standard" | "high",
): Promise<{ buffer: Buffer; mimeType: string; ext: string }> {
  const image = await getImageProvider().generate(brief.imagePrompt, { aspectRatio, quality });
  return { buffer: image.buffer, mimeType: image.mimeType, ext: extForMime(image.mimeType) };
}

/** Shared bits every produced creative needs: which workspace/business owns it, image quality, and
 * the resolved product context (for the vector/grounding path). Bundled so the per-brief producer
 * doesn't take a long positional param list. */
interface CreativeProductionContext {
  workspaceId: string;
  businessId: string;
  context: string;
  aspectRatio: "square" | "portrait" | "landscape";
  language?: string;
  quality?: "standard" | "high";
}

/**
 * Produce ONE full creative from an already-decided brief: render its image, upload it, persist the
 * asset + Creative row, and return the launch-ready descriptor. Image generation prefers the
 * LLM vector path and falls back to the raster chain (see generateCreativeImage). Video is
 * handled separately by the caller (only the single-video path needs it).
 */
async function produceCreativeFromBrief(pc: CreativeProductionContext, brief: CreativeBrief): Promise<GenerationCreativeVariant> {
  const { buffer, mimeType, ext } = await generateCreativeImage(brief, pc.businessId, pc.context, pc.aspectRatio, pc.quality);
  const imageUrl = await uploadGenerated(pc.workspaceId, buffer, mimeType, ext);
  const imageAsset = await createAsset(pc.workspaceId, {
    name: brief.headline,
    type: "image",
    url: imageUrl,
    size: buffer.length,
    mimeType,
    tags: ["ai-generated", `aspect:${pc.aspectRatio}`, `lang:${pc.language ?? "English"}`, ...(brief.angle ? [`angle:${brief.angle}`] : [])],
  });
  const creative = await createCreative(pc.businessId, {
    headline: brief.headline,
    body: brief.body,
    callToAction: brief.callToAction,
    format: "image",
    tags: ["ai-generated", ...(brief.angle ? [`angle:${brief.angle}`] : [])],
    imageAssetId: imageAsset.id,
    imageUrl,
  });
  return {
    creativeId: creative.id,
    headline: brief.headline,
    body: brief.body,
    callToAction: brief.callToAction,
    angle: brief.angle,
    imageAssetId: imageAsset.id,
    imageUrl,
  };
}

/** Builds the job result from a produced burst — top-level fields mirror the first (primary)
 * creative for backward compatibility, and the full set (primary included) is carried in `variants`. */
function resultFromVariants(variants: GenerationCreativeVariant[]): GenerationJobResult {
  const primary = variants[0];
  return {
    headline: primary.headline,
    body: primary.body,
    callToAction: primary.callToAction,
    creativeId: primary.creativeId,
    imageAssetId: primary.imageAssetId,
    imageUrl: primary.imageUrl,
    videoAssetId: primary.videoAssetId,
    videoUrl: primary.videoUrl,
    variants,
  };
}

/** The single-creative video path: animate a raster hero frame into a clip (Runway can't take an
 * SVG), persist both assets, and return the one variant. Kept separate because video is per-clip
 * costly — a burst never fans out video. */
async function produceVideoCreative(pc: CreativeProductionContext, brief: CreativeBrief): Promise<GenerationCreativeVariant> {
  const { buffer, mimeType, ext } = await generateRasterImage(brief, pc.aspectRatio, pc.quality);
  const imageUrl = await uploadGenerated(pc.workspaceId, buffer, mimeType, ext);
  const imageAsset = await createAsset(pc.workspaceId, {
    name: brief.headline,
    type: "image",
    url: imageUrl,
    size: buffer.length,
    mimeType,
    tags: ["ai-generated", `aspect:${pc.aspectRatio}`, `lang:${pc.language ?? "English"}`],
  });
  const video = await getVideoProvider().generateFromImage(imageUrl, brief.imagePrompt);
  const videoUrl = await uploadGenerated(pc.workspaceId, video.buffer, video.mimeType, "mp4");
  const videoAsset = await createAsset(pc.workspaceId, {
    name: `${brief.headline} (video)`,
    type: "video",
    url: videoUrl,
    size: video.buffer.length,
    mimeType: video.mimeType,
    tags: ["ai-generated"],
  });
  const creative = await createCreative(pc.businessId, {
    headline: brief.headline,
    body: brief.body,
    callToAction: brief.callToAction,
    format: "video",
    tags: ["ai-generated"],
    imageAssetId: imageAsset.id,
    imageUrl,
    videoAssetId: videoAsset.id,
    videoUrl,
  });
  return {
    creativeId: creative.id,
    headline: brief.headline,
    body: brief.body,
    callToAction: brief.callToAction,
    angle: brief.angle,
    imageAssetId: imageAsset.id,
    imageUrl,
    videoAssetId: videoAsset.id,
    videoUrl,
  };
}

/**
 * Runs one queued GenerationJob end to end. A standalone "initial" image job now produces an
 * angle-diverse BURST of creatives (each a distinct hook + image), so the campaign has real arms
 * for the optimization bandit to test rather than one near-duplicate — this is the single biggest
 * lever on real-market ad performance. A video job (per-clip cost) and a fatigue-refresh (wants
 * exactly one replacement for the swap) stay single. Called from the worker.
 */
export async function runGenerationJob(jobId: string): Promise<void> {
  const job = await getGenerationJob(jobId);
  if (!job) throw new Error(`GenerationJob ${jobId} not found`);

  await markGenerationJobRunning(jobId);

  try {
    const context = await resolveContext(job.input);
    const pc: CreativeProductionContext = {
      workspaceId: job.workspaceId,
      businessId: job.businessId,
      context,
      aspectRatio: job.input.aspectRatio ?? "square",
      language: job.input.language,
      quality: job.input.quality,
    };

    // A video job and a fatigue-refresh both want exactly one creative; a standalone image job
    // fans out into an angle-diverse burst (clamped to the configured ceiling).
    const single = job.input.wantVideo || job.input.reason === "fatigue-refresh";
    const count = single
      ? 1
      : Math.max(1, Math.min(job.input.variantCount ?? DEFAULT_CREATIVE_VARIANTS, MAX_CREATIVE_VARIANTS));

    const briefs = await generateCreativeBriefSet(context, count, job.input.language);

    if (job.input.wantVideo) {
      const variant = await produceVideoCreative(pc, briefs[0]);
      await markGenerationJobDone(jobId, resultFromVariants([variant]));
      return;
    }

    // Fan out image production. Tolerate partial failure — a burst that loses one angle to a
    // transient image-provider error still returns the rest, mirroring generateVectorAdImageSet.
    const settled = await Promise.all(
      briefs.map((brief, index) =>
        produceCreativeFromBrief(pc, brief).catch((err) => {
          logger.warn(`Generation job ${jobId}: creative ${index} (${brief.angle ?? "default"}) failed — dropping from burst`, err);
          return null;
        }),
      ),
    );
    const variants = settled.filter((v): v is GenerationCreativeVariant => v !== null);
    if (variants.length === 0) throw new Error("All creative variants failed to generate");

    logger.info(`Generation job ${jobId}: produced ${variants.length}/${count} creative(s) [${variants.map((v) => v.angle ?? "default").join(", ")}]`);
    await markGenerationJobDone(jobId, resultFromVariants(variants));
  } catch (err) {
    logger.error(`Generation job ${jobId} failed`, err);
    await markGenerationJobFailed(jobId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export { createGenerationJob };
