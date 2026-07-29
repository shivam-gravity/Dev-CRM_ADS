import type { MetaCredentials } from "./AdAdapter.js";
import { toMetaCtaType } from "./metaAdapter.js";
import { logger } from "../logger/logger.js";

const GRAPH_VERSION = "v22.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const ENV_META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const ENV_META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;
const hasLiveCredentials = Boolean(ENV_META_ACCESS_TOKEN && ENV_META_AD_ACCOUNT_ID);

function resolveCredentials(explicit?: MetaCredentials): MetaCredentials | null {
  if (explicit) return explicit;
  if (hasLiveCredentials) return { accessToken: ENV_META_ACCESS_TOKEN!, adAccountId: ENV_META_AD_ACCOUNT_ID!, currency: "USD" };
  return null;
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 3, delay = 500): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      logger.info(`Sending Request: ${options.method || "GET"} ${url.split("?")[0]} (Attempt ${i + 1}/${retries})`);
      const res = await fetch(url, options);
      if (res.ok) {
        return res;
      }
      logger.warn(`Meta Ads API returned status ${res.status}. Attempt ${i + 1} failed.`);
      if (i === retries - 1) {
        throw new Error(`Meta API returned ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      logger.error(`Network Exception on Meta Ads fetch attempt ${i + 1}`, err);
      if (i === retries - 1) throw err;
    }
    await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
  }
  throw new Error("Meta Ads HTTP request failed after maximum retries");
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type AdPreviewFormat =
  | "DESKTOP_FEED_STANDARD"
  | "MOBILE_FEED_STANDARD"
  | "INSTAGRAM_STANDARD"
  | "INSTAGRAM_STORY"
  | "INSTAGRAM_REELS"
  | "RIGHT_COLUMN_STANDARD"
  | "MARKETPLACE_MOBILE"
  | "AUDIENCE_NETWORK_INSTREAM_VIDEO";

export interface AdPreviewResult {
  format: AdPreviewFormat;
  /** HTML iframe content from Meta */
  body: string;
}

export interface CreativePreviewInput {
  pageId: string;
  headline: string;
  body: string;
  linkUrl: string;
  imageHash?: string;
  videoId?: string;
  callToAction?: string;
  instagramActorId?: string;
}

// ─── Mock Helpers ────────────────────────────────────────────────────────────

function buildMockPreviewHtml(format: AdPreviewFormat, content: { headline: string; body: string; linkUrl: string; imageHash?: string; videoId?: string; callToAction?: string }): string {
  const cta = content.callToAction || "LEARN_MORE";
  const mediaPlaceholder = content.videoId
    ? `<div style="width:100%;height:200px;background:#1a1a2e;color:#fff;display:flex;align-items:center;justify-content:center;border-radius:8px;margin-bottom:12px;">&#9654; Video Preview (${content.videoId})</div>`
    : `<div style="width:100%;height:200px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);display:flex;align-items:center;justify-content:center;border-radius:8px;margin-bottom:12px;color:#fff;font-size:14px;">${content.imageHash ? `Image: ${content.imageHash}` : "Image Placeholder"}</div>`;

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:400px;border:1px solid #ddd;border-radius:12px;padding:16px;background:#fff;">
  <div style="font-size:11px;color:#65676b;margin-bottom:8px;">[${format}] Mock Preview</div>
  ${mediaPlaceholder}
  <h3 style="margin:0 0 8px;font-size:16px;color:#1c1e21;">${content.headline}</h3>
  <p style="margin:0 0 12px;font-size:14px;color:#606770;">${content.body}</p>
  <a href="${content.linkUrl}" style="display:inline-block;padding:8px 16px;background:#1877f2;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">${cta.replace(/_/g, " ")}</a>
</div>`;
}

// ─── Feature 1: Generate Ad Preview from Existing Ad ─────────────────────────

/**
 * Fetches ad previews for an existing ad across multiple placements.
 * GET /{adId}/previews?ad_format={format}
 */
export async function generateAdPreview(
  adId: string,
  formats: AdPreviewFormat[],
  credentials?: MetaCredentials,
): Promise<AdPreviewResult[]> {
  const creds = resolveCredentials(credentials);

  if (!creds) {
    logger.info(`Mock mode: generating ad preview placeholders for ad ${adId} in ${formats.length} formats`);
    return formats.map((format) => ({
      format,
      body: buildMockPreviewHtml(format, {
        headline: "Sample Ad Headline",
        body: "This is a preview of your ad in mock mode.",
        linkUrl: "https://example.com",
      }),
    }));
  }

  const results: AdPreviewResult[] = [];

  for (const format of formats) {
    const url = `${GRAPH_BASE}/${adId}/previews?ad_format=${format}&access_token=${creds.accessToken}`;
    try {
      const res = await fetchWithRetry(url, { method: "GET" });
      const json = (await res.json()) as { data?: Array<{ body?: string }> };

      if (json.data && json.data.length > 0 && json.data[0].body) {
        results.push({ format, body: json.data[0].body });
      } else {
        logger.warn(`No preview data returned for ad ${adId} in format ${format}`);
        results.push({ format, body: `<!-- No preview available for format ${format} -->` });
      }
    } catch (err) {
      logger.error(`Failed to fetch preview for ad ${adId} in format ${format}`, err);
      results.push({ format, body: `<!-- Preview fetch failed for format ${format} -->` });
    }
  }

  logger.info(`Generated ${results.length} ad previews for ad ${adId}`);
  return results;
}

// ─── Feature 2: Generate Preview from Creative Spec ──────────────────────────

/**
 * Generates previews from a creative specification (without needing a published ad).
 * POST /act_{adAccountId}/generatepreviews with creative_spec
 */
export async function generateCreativePreview(
  input: CreativePreviewInput,
  adAccountId: string,
  formats: AdPreviewFormat[],
  credentials?: MetaCredentials,
): Promise<AdPreviewResult[]> {
  const creds = resolveCredentials(credentials);

  if (!creds) {
    logger.info(`Mock mode: generating creative preview placeholders for ${formats.length} formats`);
    return formats.map((format) => ({
      format,
      body: buildMockPreviewHtml(format, {
        headline: input.headline,
        body: input.body,
        linkUrl: input.linkUrl,
        imageHash: input.imageHash,
        videoId: input.videoId,
        callToAction: input.callToAction,
      }),
    }));
  }

  const linkData: Record<string, unknown> = {
    message: input.body,
    link: input.linkUrl,
    name: input.headline,
    call_to_action: { type: toMetaCtaType(input.callToAction), value: { link: input.linkUrl } },
  };
  if (input.imageHash) linkData.image_hash = input.imageHash;

  const objectStorySpec: Record<string, unknown> = { page_id: input.pageId };
  if (input.instagramActorId) objectStorySpec.instagram_actor_id = input.instagramActorId;

  if (input.videoId) {
    objectStorySpec.video_data = {
      video_id: input.videoId,
      message: input.body,
      call_to_action: { type: toMetaCtaType(input.callToAction), value: { link: input.linkUrl } },
    };
  } else {
    objectStorySpec.link_data = linkData;
  }

  const creativeSpec = JSON.stringify({ object_story_spec: objectStorySpec });
  const results: AdPreviewResult[] = [];

  for (const format of formats) {
    const url = `${GRAPH_BASE}/act_${adAccountId}/generatepreviews?access_token=${creds.accessToken}`;
    try {
      const res = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creative: creativeSpec,
          ad_format: format,
        }),
      });
      const json = (await res.json()) as { data?: Array<{ body?: string }> };

      if (json.data && json.data.length > 0 && json.data[0].body) {
        results.push({ format, body: json.data[0].body });
      } else {
        logger.warn(`No creative preview data for format ${format}`);
        results.push({ format, body: `<!-- No preview available for format ${format} -->` });
      }
    } catch (err) {
      logger.error(`Failed to generate creative preview for format ${format}`, err);
      results.push({ format, body: `<!-- Preview generation failed for format ${format} -->` });
    }
  }

  logger.info(`Generated ${results.length} creative previews for page ${input.pageId}`);
  return results;
}

// ─── Feature 3: Get Available Placements ─────────────────────────────────────

export interface PlacementInfo {
  platform: string;
  position: string;
  estimatedReach?: number;
}

/**
 * Checks which placements are available for an ad account via the delivery_estimate endpoint.
 * GET /act_{adAccountId}/delivery_estimate
 */
export async function getAvailablePlacements(
  adAccountId: string,
  credentials?: MetaCredentials,
): Promise<PlacementInfo[]> {
  const creds = resolveCredentials(credentials);

  if (!creds) {
    logger.info(`Mock mode: returning default available placements for account ${adAccountId}`);
    return [
      { platform: "facebook", position: "feed", estimatedReach: 850000 },
      { platform: "facebook", position: "right_hand_column", estimatedReach: 420000 },
      { platform: "facebook", position: "marketplace", estimatedReach: 310000 },
      { platform: "instagram", position: "stream", estimatedReach: 720000 },
      { platform: "instagram", position: "story", estimatedReach: 650000 },
      { platform: "instagram", position: "reels", estimatedReach: 580000 },
      { platform: "audience_network", position: "classic", estimatedReach: 200000 },
    ];
  }

  const url = `${GRAPH_BASE}/act_${adAccountId}/delivery_estimate?optimization_goal=LINK_CLICKS&targeting_spec=${encodeURIComponent(JSON.stringify({ geo_locations: { countries: ["US"] } }))}&access_token=${creds.accessToken}`;

  try {
    const res = await fetchWithRetry(url, { method: "GET" });
    const json = (await res.json()) as { data?: Array<{ estimate_ready?: boolean; publisher_platforms?: string[]; facebook_positions?: string[]; instagram_positions?: string[]; audience_network_positions?: string[]; estimate_dau?: number }> };

    if (!json.data || json.data.length === 0) {
      logger.warn(`No delivery estimate data for account ${adAccountId}`);
      return [];
    }

    const estimate = json.data[0];
    const placements: PlacementInfo[] = [];

    if (estimate.facebook_positions) {
      for (const pos of estimate.facebook_positions) {
        placements.push({ platform: "facebook", position: pos, estimatedReach: estimate.estimate_dau });
      }
    }

    if (estimate.instagram_positions) {
      for (const pos of estimate.instagram_positions) {
        placements.push({ platform: "instagram", position: pos, estimatedReach: estimate.estimate_dau });
      }
    }

    if (estimate.audience_network_positions) {
      for (const pos of estimate.audience_network_positions) {
        placements.push({ platform: "audience_network", position: pos, estimatedReach: estimate.estimate_dau });
      }
    }

    logger.info(`Found ${placements.length} available placements for account ${adAccountId}`);
    return placements;
  } catch (err) {
    logger.error(`Failed to fetch available placements for account ${adAccountId}`, err);
    throw err;
  }
}
