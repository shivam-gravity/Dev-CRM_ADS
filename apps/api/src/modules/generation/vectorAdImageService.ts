import { runStructured as llmRunStructured, isGeminiConfigured } from "../../infra/geminiClient.js";
import { logger } from "../logger/logger.js";
import type { ConfigurableImageProvider, GeneratedImage, ImageAspectRatio, ImageGenOptions } from "./imageProvider.js";

// Vector (SVG) ad-image generation via Claude on Amazon Bedrock.
//
// Unlike the raster providers in imageProvider.ts (OpenAI / Stability / Pollinations), which
// return PNG/JPEG *bytes* from a text-to-image model, Claude does not paint pixels — it emits vector
// markup as code. That is precisely what makes "Claude + Bedrock + vector format" coherent: we hand
// Claude a grounded, research-and-campaign-derived brief and it returns a complete, self-contained
// <svg> document (mimeType image/svg+xml), which is what the rest of the pipeline stores as an Asset.
//
// The prompt is NOT free-text: buildAdImagePrompt() assembles it deterministically from the fields
// the research pipeline (ResearchContext) and campaign generation (AdStrategy / agent creatives)
// actually produce — brand, positioning, audience, value props, CTA, palette — so the visual is
// grounded in the same facts the copy is, rather than a generic stock look.
//
// Reuses bedrockClient's forced tool-use path (concurrency-capped, retry-with-backoff, usage-metered).
// Gated on AWS_BEARER_TOKEN_BEDROCK exactly like the LLM path: no token → isConfigured() is false and
// the chain skips this provider, same posture as every other keyed provider.

/**
 * The grounded inputs a vector ad needs. Deliberately a flat, provider-agnostic shape (not the 30-field
 * ResearchContext) so it stays testable and decoupled — use vectorAdContextFrom() to derive it from the
 * research + strategy objects.
 */
export interface VectorAdContext {
  /** Brand/company name — the visual anchor. */
  brand: string;
  /** One-line positioning / what the business does (from company.summary or strategy.summary). */
  positioning?: string;
  /** The primary audience the creative should speak to. */
  audience?: string;
  /** Concrete value propositions / differentiators to imply visually. */
  valueProps?: string[];
  /** Headline text to render into the creative (kept short). */
  headline?: string;
  /** Call-to-action text to render (e.g. "Start free trial"). */
  callToAction?: string;
  /** Optional brand hex colors to anchor the palette; Claude picks a cohesive palette if omitted. */
  brandColors?: string[];
  /** Optional mood/tone words (e.g. "trustworthy", "playful", "premium"). */
  tone?: string[];
}

export interface VectorAdResult {
  /** The grounded image-generation prompt that was sent to the model. */
  imagePrompt: string;
  /** The generated vector image (SVG). */
  image: GeneratedImage;
  /** Hex colors the model reported using, for observability. */
  palette: string[];
  /** The model's one-line rationale, for observability. */
  rationale?: string;
}

const VECTOR_DIMENSIONS: Record<ImageAspectRatio, { width: number; height: number }> = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  landscape: { width: 1200, height: 628 },
};

const VECTOR_AD_MODEL = process.env.GEMINI_VECTOR_IMAGE_MODEL; // undefined → bedrockClient's BEDROCK_MODEL default
const VECTOR_AD_MAX_TOKENS = Math.max(2048, Number(process.env.GEMINI_VECTOR_IMAGE_MAX_TOKENS ?? 8192));
/** Smallest creative set to generate, so the picker still has an alternative. Env-tunable; 1 disables variety. */
const VECTOR_AD_MIN_VARIANTS = Math.max(1, Number(process.env.VECTOR_AD_MIN_VARIANTS ?? 2));
/** Upper bound — the previous hardcoded behaviour, retained as a ceiling. */
const VECTOR_AD_MAX_VARIANTS = Math.max(VECTOR_AD_MIN_VARIANTS, Number(process.env.VECTOR_AD_MAX_VARIANTS ?? 4));

const VECTOR_AD_TOOL = {
  name: "emit_vector_ad",
  description:
    "Return a grounded image-generation prompt and a complete, self-contained SVG vector ad creative for the given brand and campaign context.",
  input_schema: {
    type: "object" as const,
    properties: {
      imagePrompt: {
        type: "string",
        description:
          "A vivid, concrete art-direction brief describing the vector ad: subject, composition, iconography, color, and mood. This is the prompt the image was generated from.",
      },
      palette: {
        type: "array",
        items: { type: "string" },
        description: "The hex color codes used in the SVG, brand-appropriate and accessible (sufficient contrast for any text).",
      },
      svg: {
        type: "string",
        description:
          "A COMPLETE, valid, self-contained SVG document. STRUCTURE: start with <svg xmlns=\"http://www.w3.org/2000/svg\" and include width, height, and a matching viewBox equal to the requested dimensions. STYLE: flat modern vector design (geometric shapes, smooth linearGradients, clean iconography) — NOT a raster image, and NOT a literal drawing of a specific product (abstract/iconographic visuals only — a literal product rendering as SVG looks amateurish; suggest the category with simple recognizable icons/shapes instead). LAYOUT: keep all text and the CTA within a 8% safe-zone margin from every edge; establish a clear visual hierarchy (headline is the largest element; CTA is a filled rounded-rect button with high-contrast label; the brand wordmark appears once, small, top-left or bottom-center). TEXT: render the headline and call-to-action as <text> elements with legible sizing (headline ≥ 56px at 1080px width) and WCAG-AA contrast against whatever is behind them; wrap a long headline across 2–3 <tspan> lines rather than letting it overflow; keep the CTA label on ONE line. SAFETY: use ONLY inline vector primitives; NO <script>, NO on* event attributes, NO <image>, NO external URLs or xlink:href, NO fonts beyond system/sans-serif families.",
      },
      brandWordmarkIncluded: {
        type: "boolean",
        description: "True if the SVG renders the brand name as a small wordmark. Always include the wordmark and set this true.",
      },
      rationale: { type: "string", description: "One sentence on how the visual reflects the brand and campaign." },
    },
    required: ["imagePrompt", "svg"],
  },
};

interface VectorAdBrief {
  imagePrompt: string;
  palette?: string[];
  svg: string;
  rationale?: string;
  brandWordmarkIncluded?: boolean;
}

/**
 * Deterministically assemble the grounded image-generation prompt from the research + campaign context.
 * This is the artifact the request centers on — the prompt is built from real fields, not free text.
 */
export function buildAdImagePrompt(context: VectorAdContext, aspectRatio: ImageAspectRatio = "square"): string {
  const { width, height } = VECTOR_DIMENSIONS[aspectRatio];
  const lines: string[] = [];

  lines.push(`Design a scroll-stopping ${aspectRatio} (${width}x${height}px) VECTOR ad creative for "${context.brand}".`);
  if (context.positioning) lines.push(`What the brand does: ${context.positioning}`);
  if (context.audience) lines.push(`Target audience: ${context.audience}`);
  if (context.valueProps?.length) lines.push(`Value propositions to convey visually: ${context.valueProps.slice(0, 4).join("; ")}`);
  if (context.tone?.length) lines.push(`Tone / mood: ${context.tone.slice(0, 4).join(", ")}`);
  if (context.brandColors?.length) lines.push(`Anchor the palette on these brand colors: ${context.brandColors.join(", ")}.`);
  else lines.push("Choose a cohesive, brand-appropriate palette of 3–5 colors with one clear accent for the CTA.");

  lines.push(
    "Style: flat, modern, premium vector design — geometric shapes, smooth gradients, clean iconography, and confident negative space. Not photorealistic, not a raster image."
  );
  // Claude renders abstract/iconographic visuals reliably but botches literal product drawings (a
  // shoe reads as a boat), so steer explicitly toward category-suggesting iconography over depicting
  // the actual product — the single biggest quality fix observed in review.
  lines.push(
    "Do NOT attempt a literal illustration of the specific product — it will look amateurish. Instead suggest the category and value with abstract shapes, simple recognizable icons, and a strong background motif."
  );
  lines.push("Composition: one clear focal visual, a strong headline, and a single CTA button — balanced, with generous margins. Keep everything inside an 8% safe zone from every edge.");
  if (context.headline) lines.push(`Render this headline as the largest, most prominent text (wrap across 2–3 lines if long): "${context.headline}".`);
  if (context.callToAction) lines.push(`Include ONE clear call-to-action button with a filled rounded rectangle and a high-contrast label on a single line: "${context.callToAction}".`);
  lines.push(`Render the brand name "${context.brand}" once as a small, tasteful wordmark (top-left or bottom-center) — always include it.`);
  lines.push(`Output a complete self-contained SVG sized ${width}x${height} with a matching viewBox.`);

  return lines.join("\n");
}

/**
 * Strip anything that could make the returned SVG active/unsafe before it's stored or rendered:
 * <script> blocks, inline event handlers (on*=), javascript: URIs, and external/xlink references.
 * The model is instructed not to emit these, but we defend at the boundary regardless.
 */
function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/(href|xlink:href)\s*=\s*"(?!#)[^"]*"/gi, "")
    .replace(/(href|xlink:href)\s*=\s*'(?!#)[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

function isValidSvg(svg: string): boolean {
  const trimmed = svg.trimStart();
  return trimmed.startsWith("<svg") && /<\/svg>\s*$/i.test(svg.trimEnd());
}

/**
 * Generate a vector (SVG) ad image with Claude on Bedrock from a grounded context. Returns the prompt
 * that was used alongside the image, so callers can persist both. Throws if Bedrock is unconfigured or
 * the model returns something that isn't a usable SVG (so the caller can fall back to a raster provider).
 */
export async function generateVectorAdImage(
  context: VectorAdContext,
  options?: ImageGenOptions
): Promise<VectorAdResult> {
  if (!isGeminiConfigured()) throw new Error("GEMINI_API_KEY not set — LLM vector generation unavailable");

  const aspectRatio = options?.aspectRatio ?? "square";
  const { width, height } = VECTOR_DIMENSIONS[aspectRatio];
  const imagePrompt = buildAdImagePrompt(context, aspectRatio);

  const system =
    "You are a senior brand designer producing production-ready SVG vector ad creatives for paid social feeds. " +
    "Your work looks like it came from a top agency: strong visual hierarchy (one dominant headline, one focal visual, one CTA), " +
    "generous negative space, a tight 3–5 color palette with a single accent, and pixel-clean geometric iconography. " +
    "You suggest a product's CATEGORY with abstract shapes and simple icons — you never attempt a literal illustration of a specific product, " +
    "because that looks amateurish in vector. You keep all text and the CTA inside an 8% safe zone, wrap long headlines across lines so nothing overflows, " +
    "and always place a small brand wordmark. " +
    "You always return a single complete, valid, self-contained SVG document that renders identically in any browser, with no external assets and no scripting.";

  const brief = await llmRunStructured<VectorAdBrief>({
    model: VECTOR_AD_MODEL,
    maxTokens: VECTOR_AD_MAX_TOKENS,
    system,
    tool: VECTOR_AD_TOOL,
    messages: [
      {
        role: "user",
        content: `${imagePrompt}\n\nThe SVG must be exactly ${width}x${height} with viewBox="0 0 ${width} ${height}".`,
      },
    ],
  });

  if (!brief?.svg || !isValidSvg(brief.svg)) {
    throw new Error("LLM vector generation did not return a valid SVG document");
  }

  const svg = sanitizeSvg(brief.svg);
  return {
    imagePrompt: brief.imagePrompt || imagePrompt,
    image: { buffer: Buffer.from(svg, "utf8"), mimeType: "image/svg+xml" },
    palette: brief.palette ?? [],
    rationale: brief.rationale,
  };
}

/**
 * ImageGenProvider adapter so Claude/Bedrock vector generation can slot into the generation module the
 * same way the raster providers do. `generate(prompt)` treats the incoming prompt as the art-direction
 * text and asks Claude to render it as SVG. For fully-grounded generation (brand, audience, value props),
 * prefer generateVectorAdImage(context) — it builds the prompt from research + campaign fields.
 */
export class LlmVectorImageProvider implements ConfigurableImageProvider {
  readonly name = "llm-vector";
  isConfigured(): boolean {
    return isGeminiConfigured();
  }
  async generate(prompt: string, options?: ImageGenOptions): Promise<GeneratedImage> {
    const { image } = await generateVectorAdImage({ brand: "the brand", positioning: prompt }, options);
    return image;
  }
}

/** True when Claude/Bedrock vector generation is usable (bearer token present). */
export function isVectorImageGenerationEnabled(): boolean {
  return isGeminiConfigured();
}

/** The vector provider, for callers that want SVG output specifically. */
export function getVectorImageProvider(): LlmVectorImageProvider {
  return new LlmVectorImageProvider();
}

// ── Multi-variant generation ──────────────────────────────────────────────
//
// A single ad rarely ships alone — you want a set to A/B and to fit multiple placements. This produces
// N distinct vector creatives from one grounded context by varying two axes: the creative ANGLE (an
// art-direction lens layered onto the same brand facts) and the ASPECT RATIO (so the set already covers
// feed/story/banner placements). Variants are generated concurrently; the shared bedrockClient
// concurrency cap keeps the burst within Bedrock's throttling limits.

/** Art-direction lenses used to make each variant visually distinct while staying on-brand. */
const VARIANT_ANGLES: { label: string; tone: string[] }[] = [
  { label: "bold hero", tone: ["confident", "high-contrast", "punchy"] },
  { label: "minimal & premium", tone: ["clean", "premium", "spacious"] },
  { label: "friendly & approachable", tone: ["warm", "playful", "inviting"] },
  { label: "data-driven / trustworthy", tone: ["trustworthy", "precise", "professional"] },
  { label: "energetic gradient", tone: ["vibrant", "dynamic", "modern"] },
  { label: "editorial", tone: ["sophisticated", "editorial", "refined"] },
];

/** Rotate aspect ratios across variants so a set spans feed / story / banner placements. */
const VARIANT_ASPECTS: ImageAspectRatio[] = ["square", "portrait", "landscape", "square"];

export interface VectorAdVariant extends VectorAdResult {
  /** 0-based index in the requested set. */
  index: number;
  /** The art-direction angle used for this variant. */
  angle: string;
  /** The aspect ratio used for this variant. */
  aspectRatio: ImageAspectRatio;
}

/**
 * Generate a SET of at least `count` distinct vector ad creatives (default 4) from one grounded context.
 * Each variant layers a different art-direction angle and aspect ratio onto the same brand/campaign facts.
 * Failed variants are dropped (logged), so a partial burst still returns usable images; throws only if
 * Bedrock is unconfigured or every variant fails.
 */
export async function generateVectorAdImageSet(
  context: VectorAdContext,
  count = 4
): Promise<VectorAdVariant[]> {
  if (!isGeminiConfigured()) throw new Error("GEMINI_API_KEY not set — LLM vector generation unavailable");

  // The floor used to be a hardcoded 4 regardless of how many ads existed, so a one-ad campaign
  // paid for four 8192-token image calls and discarded three. Keep a SMALL floor so the Creatives
  // panel still offers some choice, and cap at the previous 4 so this can only ever reduce cost.
  const n = Math.min(Math.max(VECTOR_AD_MIN_VARIANTS, count), VECTOR_AD_MAX_VARIANTS);
  const settled = await Promise.all(
    Array.from({ length: n }, (_, index) => {
      const angle = VARIANT_ANGLES[index % VARIANT_ANGLES.length];
      const aspectRatio = VARIANT_ASPECTS[index % VARIANT_ASPECTS.length];
      // Layer the angle's tone onto the caller's tone so each variant is genuinely distinct.
      const variantContext: VectorAdContext = {
        ...context,
        tone: [...angle.tone, ...(context.tone ?? [])],
      };
      return generateVectorAdImage(variantContext, { aspectRatio })
        .then((result): VectorAdVariant => ({ ...result, index, angle: angle.label, aspectRatio }))
        .catch((err) => {
          logger.warn(`Vector ad variant ${index} (${angle.label}/${aspectRatio}) failed`, err);
          return null;
        });
    })
  );

  const variants = settled.filter((v): v is VectorAdVariant => v !== null);
  if (variants.length === 0) throw new Error("All vector ad variants failed to generate");
  return variants;
}

/**
 * Derive the grounded VectorAdContext from the research + campaign objects the pipeline already produces.
 * Kept structurally-typed (not bound to the full ResearchContext/AdStrategy imports) so it stays decoupled
 * and testable; callers pass the relevant slices. Field names mirror the real shapes:
 *   - research.company.{name,summary}, research.audience.primaryAudience  (ResearchContext)
 *   - strategy.summary, strategy.creatives[0].{headline,callToAction}     (AdStrategy / AdCreative)
 *   - product.valueProposition / competitors.differentiators               (agent outputs)
 */
export function vectorAdContextFrom(input: {
  research?: {
    company?: { name?: string; summary?: string } | null;
    audience?: { primaryAudience?: string } | null;
    business?: { brandName?: string; logoUrls?: string[] } | null;
  };
  strategy?: {
    summary?: string;
    creatives?: { headline?: string; callToAction?: string }[];
  };
  valueProps?: string[];
  brandColors?: string[];
}): VectorAdContext {
  const { research, strategy } = input;
  const firstCreative = strategy?.creatives?.[0];
  return {
    brand: research?.business?.brandName || research?.company?.name || "the brand",
    positioning: strategy?.summary || research?.company?.summary || undefined,
    audience: research?.audience?.primaryAudience || undefined,
    valueProps: input.valueProps,
    headline: firstCreative?.headline,
    callToAction: firstCreative?.callToAction,
    brandColors: input.brandColors,
  };
}
