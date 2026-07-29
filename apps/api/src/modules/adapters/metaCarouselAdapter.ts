import type { MetaCredentials } from "./AdAdapter.js";
import { toMetaCtaType } from "./metaAdapter.js";
import { logger } from "../logger/logger.js";

const GRAPH_VERSION = "v22.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const ENV_META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const ENV_META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;
const hasLiveCredentials = Boolean(ENV_META_ACCESS_TOKEN && ENV_META_AD_ACCOUNT_ID);

function mockId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

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

async function graphPost(path: string, accessToken: string, body: Record<string, unknown>): Promise<any> {
  const url = `${GRAPH_BASE}${path}?access_token=${accessToken}`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CarouselCard {
  headline: string;
  description?: string;
  linkUrl: string;
  imageHash?: string;
  imageUrl?: string;
  videoId?: string;
  /** CTA type: LEARN_MORE, SHOP_NOW, SIGN_UP, BOOK_TRAVEL, DOWNLOAD, GET_OFFER, etc. */
  callToAction?: string;
}

export interface CarouselAdInput {
  adSetExternalId: string;
  name: string;
  pageId: string;
  instagramActorId?: string;
  /** Between 2 and 10 cards */
  cards: CarouselCard[];
  /** Body text shown above the carousel */
  bodyText: string;
  /** "See More" destination URL */
  linkUrl: string;
}

export interface CarouselAdResult {
  adExternalId: string;
  creativeExternalId: string;
  status: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validates carousel ad input before submission.
 * - 2-10 cards required
 * - Each card needs either imageHash, imageUrl, or videoId
 * - Each card needs a headline and linkUrl
 */
export function validateCarouselInput(input: CarouselAdInput): ValidationResult {
  const errors: string[] = [];

  if (!input.cards || input.cards.length < 2) {
    errors.push("Carousel requires at least 2 cards");
  }

  if (input.cards && input.cards.length > 10) {
    errors.push("Carousel allows at most 10 cards");
  }

  if (!input.name || input.name.trim().length === 0) {
    errors.push("Ad name is required");
  }

  if (!input.pageId || input.pageId.trim().length === 0) {
    errors.push("Page ID is required");
  }

  if (!input.adSetExternalId || input.adSetExternalId.trim().length === 0) {
    errors.push("Ad Set external ID is required");
  }

  if (!input.bodyText || input.bodyText.trim().length === 0) {
    errors.push("Body text is required");
  }

  if (!input.linkUrl || input.linkUrl.trim().length === 0) {
    errors.push("Link URL is required");
  }

  if (input.cards) {
    for (let i = 0; i < input.cards.length; i++) {
      const card = input.cards[i];
      const cardLabel = `Card ${i + 1}`;

      if (!card.headline || card.headline.trim().length === 0) {
        errors.push(`${cardLabel}: headline is required`);
      }

      if (!card.linkUrl || card.linkUrl.trim().length === 0) {
        errors.push(`${cardLabel}: linkUrl is required`);
      }

      if (!card.imageHash && !card.imageUrl && !card.videoId) {
        errors.push(`${cardLabel}: must have either imageHash, imageUrl, or videoId`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Asset Upload ────────────────────────────────────────────────────────────

/**
 * Uploads any cards that have imageUrl (not yet uploaded as a hash) and returns
 * a new array of cards with imageHash populated from the Meta API response.
 */
export async function uploadCarouselAssets(
  cards: CarouselCard[],
  credentials?: MetaCredentials,
): Promise<CarouselCard[]> {
  const creds = resolveCredentials(credentials);

  if (!creds) {
    logger.info(`Mock mode: generating mock image hashes for ${cards.length} carousel cards`);
    return cards.map((card) => {
      if (card.imageUrl && !card.imageHash) {
        return { ...card, imageHash: mockId("imghash") };
      }
      return { ...card };
    });
  }

  const results: CarouselCard[] = [];

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];

    if (card.imageUrl && !card.imageHash) {
      logger.info(`Uploading image for carousel card ${i + 1}: ${card.imageUrl}`);
      try {
        const json = await graphPost(`/act_${creds.adAccountId}/adimages`, creds.accessToken, {
          url: card.imageUrl,
        });
        const firstImage = json?.images ? (Object.values(json.images)[0] as { hash?: string } | undefined) : undefined;
        if (!firstImage?.hash) {
          throw new Error(`Meta image upload failed for card ${i + 1}: ${JSON.stringify(json)}`);
        }
        results.push({ ...card, imageHash: firstImage.hash });
        logger.info(`Card ${i + 1} image uploaded successfully, hash: ${firstImage.hash}`);
      } catch (err) {
        logger.error(`Failed to upload image for carousel card ${i + 1}`, err);
        throw err;
      }
    } else {
      results.push({ ...card });
    }
  }

  logger.info(`Carousel asset upload complete: ${results.length} cards processed`);
  return results;
}

// ─── Carousel Ad Creation ────────────────────────────────────────────────────

/**
 * Creates a carousel ad on Meta's Marketing API.
 * 1. Builds child_attachments array from cards
 * 2. POSTs AdCreative with object_story_spec.link_data.child_attachments
 * 3. POSTs Ad linked to the creative and the ad set
 */
export async function createCarouselAd(
  input: CarouselAdInput,
  credentials?: MetaCredentials,
): Promise<CarouselAdResult> {
  const creds = resolveCredentials(credentials);

  if (!creds) {
    logger.info(`Mock mode: creating carousel ad "${input.name}" with ${input.cards.length} cards`);
    return {
      adExternalId: mockId("meta_carousel_ad"),
      creativeExternalId: mockId("meta_carousel_creative"),
      status: "paused",
    };
  }

  // Validate before sending to API
  const validation = validateCarouselInput(input);
  if (!validation.valid) {
    throw new Error(`Carousel validation failed: ${validation.errors.join("; ")}`);
  }

  // Build child_attachments from cards
  const childAttachments = input.cards.map((card) => {
    const attachment: Record<string, unknown> = {
      link: card.linkUrl,
      name: card.headline,
    };

    if (card.description) attachment.description = card.description;
    if (card.imageHash) attachment.image_hash = card.imageHash;
    if (card.videoId) attachment.video_id = card.videoId;
    if (card.callToAction) {
      attachment.call_to_action = { type: toMetaCtaType(card.callToAction), value: { link: card.linkUrl } };
    }

    return attachment;
  });

  // Build object_story_spec for carousel format
  const objectStorySpec: Record<string, unknown> = {
    page_id: input.pageId,
    link_data: {
      message: input.bodyText,
      link: input.linkUrl,
      child_attachments: childAttachments,
      multi_share_optimized: true,
    },
  };

  if (input.instagramActorId) {
    objectStorySpec.instagram_actor_id = input.instagramActorId;
  }

  // Step 1: Create AdCreative
  logger.info(`Creating carousel AdCreative "${input.name}-creative" with ${input.cards.length} cards`);
  const creativeJson = await graphPost(`/act_${creds.adAccountId}/adcreatives`, creds.accessToken, {
    name: `${input.name}-creative`,
    object_story_spec: objectStorySpec,
  });

  if (!creativeJson?.id) {
    throw new Error(`Meta carousel creative creation failed: ${JSON.stringify(creativeJson)}`);
  }
  logger.info(`Carousel AdCreative created: ${creativeJson.id}`);

  // Step 2: Create Ad linked to the creative and ad set
  logger.info(`Creating carousel Ad "${input.name}" in ad set ${input.adSetExternalId}`);
  const adJson = await graphPost(`/act_${creds.adAccountId}/ads`, creds.accessToken, {
    name: input.name,
    adset_id: input.adSetExternalId,
    creative: { creative_id: creativeJson.id },
    status: "PAUSED",
  });

  if (!adJson?.id) {
    throw new Error(`Meta carousel ad creation failed: ${JSON.stringify(adJson)}`);
  }
  logger.info(`Carousel Ad created: ${adJson.id}`);

  return {
    adExternalId: adJson.id,
    creativeExternalId: creativeJson.id,
    status: "paused",
  };
}
