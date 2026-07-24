import { logger } from "../logger/logger.js";
import { generateImage as bedrockGenerateImage, isBedrockImageConfigured } from "../../infra/bedrockClient.js";

export interface GeneratedImage {
  buffer: Buffer;
  mimeType: string;
}

export type ImageAspectRatio = "square" | "portrait" | "landscape";
export type ImageQuality = "standard" | "high";

export interface ImageGenOptions {
  aspectRatio?: ImageAspectRatio;
  quality?: ImageQuality;
}

export interface ImageGenProvider {
  readonly name: string;
  generate(prompt: string, options?: ImageGenOptions): Promise<GeneratedImage>;
}

/** A keyed provider that's only usable when its API key env var is set. Read live (not cached at
 * construction) so the chain reflects the current environment. */
export interface ConfigurableImageProvider extends ImageGenProvider {
  isConfigured(): boolean;
}

const DIMENSIONS: Record<ImageAspectRatio, { width: number; height: number }> = {
  square: { width: 1024, height: 1024 },
  portrait: { width: 1024, height: 1280 },
  landscape: { width: 1280, height: 1024 },
};
function dimensionsFor(aspectRatio?: ImageAspectRatio): { width: number; height: number } {
  return DIMENSIONS[aspectRatio ?? "square"];
}

// Each provider maps the abstract aspect ratio to its own API's accepted value.
const OPENAI_SIZE: Record<ImageAspectRatio, string> = { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" };
const RATIO: Record<ImageAspectRatio, string> = { square: "1:1", portrait: "3:4", landscape: "4:3" };

const IMAGE_GEN_TIMEOUT_MS = 60_000;

function withTimeout(): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_GEN_TIMEOUT_MS);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// Titan requires each dimension in [320,1408] and a supported aspect ratio; these map our abstract
// ratios to Titan-accepted, ~1MP dimension pairs.
const TITAN_DIMENSIONS: Record<ImageAspectRatio, { width: number; height: number }> = {
  square: { width: 1024, height: 1024 },
  portrait: { width: 768, height: 1152 },
  landscape: { width: 1152, height: 768 },
};

/**
 * Amazon Titan Image Generator via Bedrock InvokeModel — real raster (PNG) images on the SAME
 * bearer token as the LLM/embeddings (AWS_BEARER_TOKEN_BEDROCK), so photoreal ad creatives need NO
 * dedicated image-API key. Highest priority in the keyed chain: the platform already has this token,
 * and raster photography outperforms flat vector art on the social feed. cfgScale/dimensions map the
 * abstract options to Titan's config; auth/retry/concurrency are reused from bedrockClient.
 */
export class BedrockTitanImageProvider implements ConfigurableImageProvider {
  readonly name = "bedrock-titan";
  isConfigured(): boolean {
    return isBedrockImageConfigured();
  }
  async generate(prompt: string, options?: ImageGenOptions): Promise<GeneratedImage> {
    const { width, height } = TITAN_DIMENSIONS[options?.aspectRatio ?? "square"];
    const buffer = await bedrockGenerateImage(prompt, { width, height });
    if (!buffer || buffer.length === 0) throw new Error("Bedrock Titan returned no image bytes");
    return { buffer, mimeType: "image/png" };
  }
}

/**
 * Google Imagen via the Gemini API's :predict REST endpoint — image generation only, gated on its
 * own GEMINI_API_KEY (the LLM pipeline is Bedrock-only and does not use this key). Model overridable
 * via IMAGEN_MODEL.
 */
export class GoogleImagenImageProvider implements ConfigurableImageProvider {
  readonly name = "google-imagen";
  isConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }
  async generate(prompt: string, options?: ImageGenOptions): Promise<GeneratedImage> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY not set");
    const model = process.env.IMAGEN_MODEL ?? "imagen-3.0-generate-002";
    const { signal, clear } = withTimeout();
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: { sampleCount: 1, aspectRatio: RATIO[options?.aspectRatio ?? "square"] },
        }),
      });
      if (!res.ok) throw new Error(`Imagen returned ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { predictions?: { bytesBase64Encoded?: string; mimeType?: string }[] };
      const prediction = json.predictions?.[0];
      if (!prediction?.bytesBase64Encoded) throw new Error("Imagen returned no image bytes");
      return { buffer: Buffer.from(prediction.bytesBase64Encoded, "base64"), mimeType: prediction.mimeType ?? "image/png" };
    } finally {
      clear();
    }
  }
}

/** OpenAI gpt-image-1 via the images/generations REST endpoint — gated on OPENAI_API_KEY. */
export class OpenAIImageProvider implements ConfigurableImageProvider {
  readonly name = "openai-gpt-image-1";
  isConfigured(): boolean {
    return Boolean(process.env.OPENAI_API_KEY);
  }
  async generate(prompt: string, options?: ImageGenOptions): Promise<GeneratedImage> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY not set");
    const { signal, clear } = withTimeout();
    try {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        signal,
        body: JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1", prompt, n: 1, size: OPENAI_SIZE[options?.aspectRatio ?? "square"] }),
      });
      if (!res.ok) throw new Error(`OpenAI images returned ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { data?: { b64_json?: string }[] };
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new Error("OpenAI returned no image bytes");
      return { buffer: Buffer.from(b64, "base64"), mimeType: "image/png" };
    } finally {
      clear();
    }
  }
}

/** Stability AI (Stable Image Core) via its REST endpoint — gated on STABILITY_API_KEY. Returns raw
 * image bytes (Accept: image/*). */
export class StabilityImageProvider implements ConfigurableImageProvider {
  readonly name = "stability";
  isConfigured(): boolean {
    return Boolean(process.env.STABILITY_API_KEY);
  }
  async generate(prompt: string, options?: ImageGenOptions): Promise<GeneratedImage> {
    const key = process.env.STABILITY_API_KEY;
    if (!key) throw new Error("STABILITY_API_KEY not set");
    const { signal, clear } = withTimeout();
    try {
      const form = new FormData();
      form.set("prompt", prompt);
      form.set("output_format", "jpeg");
      form.set("aspect_ratio", RATIO[options?.aspectRatio ?? "square"]);
      const res = await fetch("https://api.stability.ai/v2beta/stable-image/generate/core", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, Accept: "image/*" },
        signal,
        body: form,
      });
      if (!res.ok) throw new Error(`Stability returned ${res.status}: ${await res.text()}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) throw new Error("Stability returned an empty image");
      return { buffer, mimeType: res.headers.get("content-type") ?? "image/jpeg" };
    } finally {
      clear();
    }
  }
}

const POLLINATIONS_BASE = "https://image.pollinations.ai/prompt";

/**
 * Keyless AI image generation via Pollinations — the last real-image tier, so even with no API keys
 * configured the pipeline still yields a real, prompt-relevant image (never a blank) before the
 * placeholder. Bytes are fetched server-side and returned as a Buffer, same as the keyed providers.
 */
export class PollinationsImageProvider implements ImageGenProvider {
  readonly name = "pollinations";
  async generate(prompt: string, options?: ImageGenOptions): Promise<GeneratedImage> {
    const { width, height } = dimensionsFor(options?.aspectRatio);
    const url = `${POLLINATIONS_BASE}/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true`;
    const { signal, clear } = withTimeout();
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`Pollinations returned ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) throw new Error("Pollinations returned an empty image");
      return { buffer, mimeType: res.headers.get("content-type") ?? "image/jpeg" };
    } finally {
      clear();
    }
  }
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] as string));
}

/**
 * Self-contained, always-succeeds final fallback: a branded gradient card carrying a snippet of the
 * prompt, so a creative preview shows something legible instead of a blank/1x1 image when every
 * real provider is unavailable.
 */
export class PlaceholderImageProvider implements ImageGenProvider {
  readonly name = "placeholder";
  async generate(prompt: string, options?: ImageGenOptions): Promise<GeneratedImage> {
    const { width, height } = dimensionsFor(options?.aspectRatio);
    const label = escapeXml(prompt.trim().slice(0, 120) || "Ad creative preview");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d28d9"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs>` +
      `<rect width="100%" height="100%" fill="url(#g)"/>` +
      `<text x="50%" y="45%" fill="#ffffff" font-family="system-ui, sans-serif" font-size="36" font-weight="700" text-anchor="middle">Creative preview</text>` +
      `<foreignObject x="8%" y="52%" width="84%" height="40%"><div xmlns="http://www.w3.org/1999/xhtml" style="color:#e5e7ff;font:400 22px system-ui,sans-serif;text-align:center">${label}</div></foreignObject>` +
      `</svg>`;
    return { buffer: Buffer.from(svg, "utf8"), mimeType: "image/svg+xml" };
  }
}

/**
 * The default: a prioritized fallback chain across multiple image APIs to maximize real-image
 * coverage. Keyed premium APIs first (Google Imagen -> OpenAI gpt-image-1 -> Stability), each
 * skipped unless its key is set; then keyless Pollinations; then the always-succeeds placeholder.
 * Each tier is tried in order until one yields real bytes, so a failed/unconfigured/slow provider
 * never blanks the image and never fails the creative-generation job.
 */
export class DefaultImageProvider implements ImageGenProvider {
  readonly name = "image-chain";
  private readonly keyed: ConfigurableImageProvider[] = [
    new BedrockTitanImageProvider(),
    new GoogleImagenImageProvider(),
    new OpenAIImageProvider(),
    new StabilityImageProvider(),
  ];
  private readonly pollinations = new PollinationsImageProvider();
  private readonly placeholder = new PlaceholderImageProvider();

  /** Keyed providers currently enabled by env, in priority order — for observability/tests. */
  configuredProviders(): string[] {
    return this.keyed.filter((p) => p.isConfigured()).map((p) => p.name);
  }

  async generate(prompt: string, options?: ImageGenOptions): Promise<GeneratedImage> {
    const chain: ImageGenProvider[] = [...this.keyed.filter((p) => p.isConfigured()), this.pollinations];
    for (const provider of chain) {
      try {
        const image = await provider.generate(prompt, options);
        if (image.buffer.length > 0) return image;
        logger.warn(`Image generation via ${provider.name} returned an empty image — trying next provider`);
      } catch (err) {
        logger.warn(`Image generation via ${provider.name} failed — trying next provider`, err);
      }
    }
    return this.placeholder.generate(prompt, options);
  }
}

/** Retained for tests/back-compat — a 1x1 transparent PNG. No longer used in the default chain. */
export class MockImageProvider implements ImageGenProvider {
  readonly name = "mock";
  async generate(_prompt: string, _options?: ImageGenOptions): Promise<GeneratedImage> {
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    return { buffer: onePixelPng, mimeType: "image/png" };
  }
}

// Providers whose credential is SHARED with the LLM pipeline, so their mere presence must NOT act as
// an enable-trigger — a Bedrock token (bedrock-titan) or Gemini key (google-imagen) set for the LLM
// shouldn't silently flip on the metered image subsystem (and its keyless-tier pollinations.ai
// network dependency) for every existing deployment. Both stay fully usable as PROVIDERS once image
// generation is enabled by another trigger; they just can't enable the feature by themselves.
const SHARED_KEY_PROVIDERS = new Set(["bedrock-titan", "google-imagen"]);

/**
 * Whether the real multi-provider image chain is active. It's OPT-IN because its keyless tier
 * makes a live pollinations.ai network call — matching how the platform gates real-vs-mock
 * elsewhere (ad networks, etc.). Enabled when IMAGE_GENERATION_ENABLED=true is set explicitly,
 * OR when a DEDICATED image API key is configured (OPENAI_API_KEY / STABILITY_API_KEY — setting
 * one clearly signals the operator wants real images). The shared Bedrock/Gemini credentials are
 * deliberately NOT triggers (see SHARED_KEY_PROVIDERS). Reuses each provider's own isConfigured()
 * via configuredProviders() (minus the shared-credential providers), so there's no separate env-var
 * list to drift. Otherwise the instant in-process mock is used and creative generation acquires no
 * live network dependency by default.
 */
export function isImageGenerationEnabled(): boolean {
  return (
    process.env.IMAGE_GENERATION_ENABLED === "true" ||
    new DefaultImageProvider().configuredProviders().some((name) => !SHARED_KEY_PROVIDERS.has(name))
  );
}

export function getImageProvider(): ImageGenProvider {
  return isImageGenerationEnabled() ? new DefaultImageProvider() : new MockImageProvider();
}
