import { randomUUID } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { metaAdapter } from "../adapters/metaAdapter.js";
import { googleAdapter } from "../adapters/googleAdapter.js";
import { tiktokAdapter } from "../adapters/tiktokAdapter.js";
import type { AdAdapter, HierarchyCapableAdapter } from "../adapters/AdAdapter.js";
import { resolveAudienceTargetingForWorkspace, withAgentInterests } from "../adapters/metaTargetingMapper.js";
import { isValidObjective } from "../adapters/metaObjectives.js";
import { resolveGoogleTargetingForWorkspace, buildGoogleCampaignTargetingFromLocations, withAgentKeywords } from "../adapters/googleTargetingMapper.js";
import { getMetaCredentials, markMetaConnectionError } from "../integrations/integrationService.js";
import { objectStorage } from "../../infra/objectStorage.js";
import { rasterizeSvgToPng } from "../../infra/svgRasterizer.js";
import { refreshMetaToken } from "../integrations/metaTokenRefresh.js";
import { MetaGraphError } from "../adapters/metaAdapter.js";
import { getGoogleAdsCredentials, type GoogleAdsCredentials } from "../integrations/googleOAuth.js";
import { withLock, LockAlreadyHeldError } from "../../infra/distributedLock.js";
import type { AdNetwork, Campaign, CampaignSuggestion, CampaignVariant, CreativeAssetRef } from "../../types/index.js";
import { getStrategy } from "../strategy/strategyEngine.js";
import { applyCopyLimitsForNetwork } from "../strategy/platformCopyLimits.js";
import { getBusiness } from "../business/businessService.js";
import { eventBus } from "../../infra/eventBus.js";
import { ensureFuseGuardrails } from "../automation/campaignFuse.js";
import { syncLaunchedHierarchy } from "../drafts/draftsService.js";
import { logger } from "../logger/logger.js";
import { isActiveNetwork } from "../../config/platforms.js";

export interface CampaignLaunchedEvent {
  campaignId: string;
  businessId: string;
  activeVariants: number;
  totalVariants: number;
}

const LANDING_PAGE_SLUGS = ["", "offer", "checkout", "pricing"];

// How many distinct ad creatives a generated campaign should contain PER launchable network.
// The StrategyAgent emits 8-12 creatives (for variety/selection headroom), but surfacing all of
// them in the builder is overwhelming and confusing (the sidebar even truncated the list to 8
// while the count said 14). Cap the creatives actually turned into variants so the user gets a
// focused, editable set. 4 = enough distinct angles to A/B without noise. Env-tunable.
const MAX_CREATIVES_PER_CAMPAIGN = Math.max(1, Number(process.env.MAX_CREATIVES_PER_CAMPAIGN ?? 4));
const DEFAULT_META_OBJECTIVE = "OUTCOME_TRAFFIC";

/**
 * Build the image upload input for a Meta ad creative. Meta's /adimages can't fetch a locally-
 * stored/relative URL and rejects SVG, so a creative stored as a local `.svg` under /objects is
 * read from object storage, rasterized to PNG (via scraper-service), and passed as raw bytes.
 * A remote raster URL (http/https, non-svg) is passed through as a url for Meta to fetch.
 * Falls back to the original imageUrl if rasterization fails, so the ad still attempts to publish.
 */
async function resolveMetaImageUpload(imageUrl: string | undefined, videoUrl: string | undefined): Promise<{ imageUrl?: string; videoUrl?: string; imageBytesBase64?: string }> {
  if (videoUrl) return { videoUrl };
  if (!imageUrl) return {};
  const isSvg = imageUrl.toLowerCase().endsWith(".svg");
  const isLocalObject = imageUrl.startsWith("/objects/");
  if (isSvg || isLocalObject) {
    try {
      // Local object key is the path after "/objects/". Read the stored file (SVG markup or raster).
      const key = imageUrl.replace(/^\/objects\//, "");
      const buf = await objectStorage.get(key);
      if (buf) {
        if (isSvg) {
          const png = await rasterizeSvgToPng(buf.toString("utf8"));
          if (png) return { imageBytesBase64: png.toString("base64") };
        } else {
          // Already-raster local file — upload its bytes directly (Meta still can't fetch a local URL).
          return { imageBytesBase64: buf.toString("base64") };
        }
      }
    } catch (err) {
      logger.warn(`resolveMetaImageUpload: could not rasterize/read ${imageUrl} — falling back to URL`, err);
    }
  }
  // Remote, fetchable raster URL — let Meta pull it.
  return { imageUrl };
}

const adapters: Record<AdNetwork, AdAdapter & Partial<HierarchyCapableAdapter>> = {
  meta: metaAdapter,
  google: googleAdapter,
  tiktok: tiktokAdapter,
};

/**
 * Absolute base URL that every generated variant's landingPageUrl hangs off.
 *
 * A plain `business.website ?? fallback` is NOT enough: the onboarding default for a business
 * with no site is an EMPTY STRING, which `??` happily passes through (it only catches
 * null/undefined). baseUrl then became "" and every landingPageUrl came out RELATIVE —
 * "/offer", "/pricing". Meta rejects a relative link outright ("#100 url should represent a
 * valid URL"), so the damage only surfaced at publish time, per-variant, as a failed ad.
 * Treating blank/whitespace as missing keeps the failure at build time where it's visible.
 */
function landingPageBaseUrl(website: string | undefined): string {
  const trimmed = website?.trim();
  return trimmed ? trimmed.replace(/\/$/, "") : "https://example.com";
}

/**
 * Best user-facing reason for a launch failure. Prefers Meta's end-user-safe error_user_msg
 * (carried on MetaGraphError.userMessage) over the raw exception text, and truncates so a giant
 * Graph payload doesn't bloat the persisted campaign JSON. Used to fill CampaignVariant.failureReason
 * so the UI can show WHY a variant failed instead of a bare "Failed".
 */
function launchFailureReason(err: unknown): string {
  if (err instanceof MetaGraphError && err.userMessage) return err.userMessage.slice(0, 300);
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}

export async function saveCampaign(campaign: Campaign): Promise<void> {
  await prisma.campaign.upsert({
    where: { id: campaign.id },
    create: { id: campaign.id, businessId: campaign.businessId, workspaceId: campaign.workspaceId, data: campaign as any, updatedAt: new Date(campaign.updatedAt) },
    update: { workspaceId: campaign.workspaceId, data: campaign as any, updatedAt: new Date(campaign.updatedAt) },
  });
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  const row = await prisma.campaign.findUnique({ where: { id } });
  return row ? (row.data as unknown as Campaign) : null;
}

export class CampaignLaunchedDeleteError extends Error {
  constructor() {
    super("This campaign has been launched — pause its ads before deleting so live/paused Meta or Google objects aren't abandoned.");
    this.name = "CampaignLaunchedDeleteError";
  }
}

/**
 * Deletes a campaign and its mirrored Ads-Manager rows (AdSet/Ad) and Metrics. Refuses to delete a
 * campaign that was ever launched — i.e. has a platform externalId or a non-draft status — because
 * the real Meta/Google campaign/ad-set/ad objects would be orphaned (and a paused one can be
 * resumed to spend). Only genuine drafts are deletable; callers get CampaignLaunchedDeleteError
 * otherwise so the route can return a clear 409. Ad rows link to a campaign only via their AdSet,
 * so they're removed by walking campaign -> ad sets -> ads.
 */
export async function deleteCampaign(id: string): Promise<boolean> {
  const row = await prisma.campaign.findUnique({ where: { id } });
  if (!row) return false;
  const campaign = row.data as unknown as Campaign;

  const wasLaunched =
    campaign.status !== "draft" ||
    Boolean(campaign.externalIds?.meta || campaign.externalIds?.google) ||
    (campaign.variants ?? []).some((v) => v.externalId);
  if (wasLaunched) throw new CampaignLaunchedDeleteError();

  // Best-effort cleanup of the mirrored Ads-Manager hierarchy (only present if a prior launch
  // synced it; a pure draft has none). Ads are keyed by adSetId, so collect this campaign's ad sets
  // first, then delete their ads, then the ad sets, metrics, and finally the campaign row.
  const adSets = await prisma.adSet.findMany({ where: { campaignId: id }, select: { id: true } });
  const adSetIds = adSets.map((a) => a.id);
  if (adSetIds.length) await prisma.ad.deleteMany({ where: { adSetId: { in: adSetIds } } });
  await prisma.adSet.deleteMany({ where: { campaignId: id } });
  await prisma.metric.deleteMany({ where: { campaignId: id } });
  await prisma.campaign.delete({ where: { id } });
  return true;
}

export async function listCampaignsForBusiness(businessId: string): Promise<Campaign[]> {
  const rows = await prisma.campaign.findMany({ where: { businessId }, orderBy: { updatedAt: "desc" } });
  return rows.map((r) => r.data as unknown as Campaign);
}

/** Powers the scheduled metrics-ingestion worker — every campaign currently spending, across every business/workspace, via a Postgres JSON-path filter on the schemaless `data` column. workspaceId falls back to "demo" for the rare pre-existing row launched before campaign.workspaceId started being persisted. */
export async function listActiveCampaigns(): Promise<{ id: string; workspaceId: string }[]> {
  const rows = await prisma.campaign.findMany({ where: { data: { path: ["status"], equals: "active" } }, select: { id: true, workspaceId: true } });
  return rows.map((r) => ({ id: r.id, workspaceId: r.workspaceId ?? "demo" }));
}

/** Builds a campaign draft from a strategy: one variant per creative x recommended network.
 * `objective` (optional) is the user-chosen Meta objective from the generation flow, stamped
 * onto the campaign so launchMetaHierarchy uses it instead of the hardcoded default. */
export async function buildCampaignFromStrategy(strategyId: string, name: string, dailyBudgetCents: number, objective?: string): Promise<Campaign> {
  const strategy = await getStrategy(strategyId);
  if (!strategy) throw new Error(`Strategy ${strategyId} not found`);
  const business = await getBusiness(strategy.businessId);
  const baseUrl = landingPageBaseUrl(business?.website);

  let variantIndex = 0;
  // Only build variants for networks we can actually launch on (config/platforms.ts). A strategy's
  // recommendedNetworks can name a "coming soon" network (e.g. market research recommends TikTok),
  // and buildCampaignFromStrategy feeds launchCampaign directly — so we drop inactive networks here
  // rather than let them become dead variants the orchestrator has to skip at launch.
  const launchableNetworks = strategy.recommendedNetworks.filter(isActiveNetwork);
  // Each creative is shared across every recommended network above — applying each
  // network's real copy limits here (rather than reusing one Meta-shaped 40-char headline
  // verbatim on Google too) is what actually makes the final launched ad respect
  // that network's real format instead of just its generation-time upper bound.
  // Cap the creatives surfaced as variants (the agent produces 8-12 for headroom; the builder
  // should show a focused set — see MAX_CREATIVES_PER_CAMPAIGN). Applied here, at the single point
  // variants are built, so both the count badge and the list agree and no launch fan-out explodes.
  const cappedCreatives = strategy.creatives.slice(0, MAX_CREATIVES_PER_CAMPAIGN);
  const variants: CampaignVariant[] = cappedCreatives.flatMap((creative) =>
    launchableNetworks.map((network) => {
      const audienceName = strategy.audiences[variantIndex % strategy.audiences.length] ?? "General Audience";
      const slug = LANDING_PAGE_SLUGS[variantIndex % LANDING_PAGE_SLUGS.length];
      variantIndex++;
      return {
        id: randomUUID(),
        creative: applyCopyLimitsForNetwork(creative, network),
        network,
        status: "draft" as const,
        audienceName,
        landingPageUrl: slug ? `${baseUrl}/${slug}` : `${baseUrl}/`,
      };
    })
  );

  const campaign: Campaign = {
    id: randomUUID(),
    businessId: strategy.businessId,
    // Stamp the owning workspace at BUILD time (from the business), not only at launch. Without
    // this a generated-but-unlaunched campaign persisted with workspaceId=null and was invisible
    // to every workspace-scoped query — including the CRM Automated Insights tab, which filters
    // campaigns by workspaceId. launchCampaign still sets it too (defensive), but stamping here
    // means the campaign belongs to its workspace the moment it's created.
    ...(business?.workspaceId ? { workspaceId: business.workspaceId } : {}),
    strategyId,
    name,
    status: "draft",
    networks: launchableNetworks,
    dailyBudgetCents,
    variants,
    ...(objective ? { objective } : {}),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(strategy.googleKeywords ? { googleKeywords: strategy.googleKeywords } : {}),
    ...(strategy.metaInterests ? { metaInterests: strategy.metaInterests } : {}),
  };

  await saveCampaign(campaign);
  return campaign;
}

/**
 * Builds a campaign draft from a set of AI-generated CampaignSuggestions: exactly one variant
 * per suggestion, using that suggestion's own platform as the variant's network — unlike
 * buildCampaignFromStrategy's creative × recommendedNetworks cross-product, which would put
 * every creative on every network. This is what lets "Generate Campaign" land the user straight
 * in the builder with N ready-to-edit ads (one per suggestion) instead of a single generic ad.
 */
export async function buildCampaignFromSuggestions(strategyId: string, suggestions: CampaignSuggestion[], name: string, dailyBudgetCents: number): Promise<Campaign> {
  const strategy = await getStrategy(strategyId);
  if (!strategy) throw new Error(`Strategy ${strategyId} not found`);
  const business = await getBusiness(strategy.businessId);
  const baseUrl = landingPageBaseUrl(business?.website);

  // Drop suggestions for networks we can't launch on (config/platforms.ts). A suggestion's
  // platform comes from research (which can still recommend TikTok), and this builder feeds
  // launchCampaign directly — so an inactive network would otherwise become a dead variant.
  const launchableSuggestions = suggestions.filter((s) => isActiveNetwork(s.platform));
  const variants: CampaignVariant[] = launchableSuggestions.map((suggestion, i) => {
    const audienceName = strategy.audiences[i % strategy.audiences.length] ?? "General Audience";
    const slug = LANDING_PAGE_SLUGS[i % LANDING_PAGE_SLUGS.length];
    return {
      id: randomUUID(),
      creative: { headline: suggestion.headline, body: suggestion.body, callToAction: suggestion.callToAction },
      network: suggestion.platform,
      status: "draft" as const,
      audienceName,
      landingPageUrl: slug ? `${baseUrl}/${slug}` : `${baseUrl}/`,
    };
  });

  const campaign: Campaign = {
    id: randomUUID(),
    businessId: strategy.businessId,
    strategyId,
    name,
    status: "draft",
    networks: [...new Set(variants.map((v) => v.network))],
    dailyBudgetCents,
    variants,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await saveCampaign(campaign);
  return campaign;
}

/**
 * Builds the real Meta object graph for a shared group of variants: one Campaign
 * container, one Ad Set per distinct audience (grouping variants so they share
 * budget/targeting the way Meta expects), then a Creative + Ad per variant.
 * Everything lands PAUSED — activateVariant is a separate, explicit step since this
 * is now capable of spending real money.
 */
async function launchMetaHierarchy(
  campaign: Campaign,
  variants: CampaignVariant[],
  workspaceId: string,
  perVariantBudgetCents: number
): Promise<void> {
  const workspaceCredentials = (await getMetaCredentials(workspaceId)) ?? undefined;
  // The builder lets a user pick a specific ad account/Page per campaign (dropdowns backed by
  // metaOAuth.listAdAccounts/listPages) instead of always using the workspace's default
  // Integration connection — override here when the campaign carries a selection.
  let credentials = workspaceCredentials
    ? {
        ...workspaceCredentials,
        adAccountId: campaign.metaAdAccountId ?? workspaceCredentials.adAccountId,
        pageId: campaign.pageId ?? workspaceCredentials.pageId,
      }
    : undefined;
  let accessToken = credentials?.accessToken ?? null;

  // A stored Meta long-lived token can be dead while its recorded expiry still reads "in the
  // future" (the token was invalidated server-side — password change, de-authorized app, or the
  // CRM manual-connect path storing an optimistic 60-day expiry). The scheduled refresh sweep only
  // fires on the expiry clock, so the first live publish 401s. Wrap the first Graph call: on an
  // auth error, force a token exchange and retry ONCE, mirroring launchGoogleHierarchy. This runs
  // BEFORE any ad set/ad is created, so a clean top-of-hierarchy retry has no partial-state risk.
  const refreshMetaCredentialsOnAuthError = async (): Promise<boolean> => {
    logger.warn(`launchMetaHierarchy: auth error on Graph call for ${workspaceId} — refreshing Meta token and retrying once`);
    const result = await refreshMetaToken(workspaceId);
    if (!result.success) {
      logger.error(`launchMetaHierarchy: Meta token refresh failed for ${workspaceId}: ${result.error}`);
      // Token is dead and not refreshable — flag the connection so the UI prompts a reconnect
      // instead of failing every future launch identically. Best-effort; never mask the launch error.
      await markMetaConnectionError(workspaceId, "Meta access token is invalid or expired — reconnect your Meta account.").catch(() => {});
      return false;
    }
    const refreshed = (await getMetaCredentials(workspaceId)) ?? undefined;
    if (!refreshed) return false;
    credentials = { ...refreshed, adAccountId: campaign.metaAdAccountId ?? refreshed.adAccountId, pageId: campaign.pageId ?? refreshed.pageId };
    accessToken = credentials.accessToken;
    return true;
  };
  const isMetaAuthError = (err: unknown): boolean => err instanceof MetaGraphError && err.isAuthError;

  // Use the campaign's chosen objective (threaded from the generation flow) when it's a valid
  // post-ODAX Meta objective; otherwise fall back to the historical default. Guards against a
  // stale/free-text value reaching the Graph API.
  const metaObjective = campaign.objective && isValidObjective(campaign.objective) ? campaign.objective : DEFAULT_META_OBJECTIVE;

  // Budget placement (default ABO). Under CBO the whole campaign daily budget lives on the campaign
  // container and Meta distributes it across the per-audience ad sets; ad sets then omit their own
  // budgets. Only meaningful with multiple ad sets, which the per-audience grouping below produces.
  const budgetMode: "ABO" | "CBO" = campaign.budgetMode === "CBO" ? "CBO" : "ABO";
  const containerBudget = budgetMode === "CBO" ? { budgetMode, dailyBudgetCents: campaign.dailyBudgetCents } : { budgetMode };

  // ── Idempotency: never create a second campaign container for a campaign that already has one.
  // launchCampaign is synchronous and blocks 30s–2min, so a retry or double-clicked "Launch" would
  // otherwise build a DUPLICATE Meta campaign/ad-set/ad graph and spend twice. If we already minted
  // a Meta campaign id on a prior (partial) launch, reuse it and only fill in the missing ads below.
  let campaignExternalId: string | undefined = campaign.externalIds?.meta;
  if (campaignExternalId) {
    logger.info(`launchMetaHierarchy: reusing existing Meta campaign container ${campaignExternalId} for ${campaign.id} (idempotent re-launch)`);
  } else {
    try {
      let container;
      try {
        container = await metaAdapter.createCampaignContainer!({ name: campaign.name, objective: metaObjective, ...containerBudget }, credentials);
      } catch (err) {
        if (!isMetaAuthError(err) || !(await refreshMetaCredentialsOnAuthError())) throw err;
        container = await metaAdapter.createCampaignContainer!({ name: campaign.name, objective: metaObjective, ...containerBudget }, credentials);
      }
      campaignExternalId = container.externalId;
      campaign.externalIds = { ...campaign.externalIds, meta: campaignExternalId };
    } catch (err) {
      // Campaign container is the top of the Meta hierarchy — if it fails, EVERY variant is marked
      // failed (no ad set/ad can exist without it). Log the real Graph API error; otherwise the whole
      // campaign shows a silent "Failed" with no way to tell budget/objective/token issues apart.
      logger.error(`launchMetaHierarchy: campaign container failed for ${campaign.id} (objective=${metaObjective}) — marking all ${variants.length} variants failed`, err);
      const reason = launchFailureReason(err);
      variants.forEach((v) => { v.status = "failed"; v.failureReason = reason; });
      return;
    }
  }

  const groups = new Map<string, CampaignVariant[]>();
  for (const variant of variants) {
    const key = variant.audienceName ?? "General Audience";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(variant);
  }

  for (const [audienceName, groupVariants] of groups) {
    try {
      // ── Idempotency for the AD SET, mirroring the campaign-container reuse above. ──
      // This was the one hierarchy level with no reuse, and it leaked real objects: a launch that
      // created the ad set but then failed on the ad (rejected creative, Graph 400, missing image)
      // left the ad set behind — and since retrying IS the documented recovery path, every retry
      // created ANOTHER identical ad set. Observed live: two duplicate ₹100/day ad sets from a
      // single retry. They were paused so nothing was spent, but under CBO or after activation
      // duplicates divide (or multiply) real budget.
      // Any variant in this group already carrying an adSetExternalId identifies the group's ad set.
      const existingAdSetId = groupVariants.find((v) => v.adSetExternalId)?.adSetExternalId;
      let adSetExternalId: string;
      if (existingAdSetId) {
        logger.info(`launchMetaHierarchy: reusing existing Meta ad set ${existingAdSetId} for audience "${audienceName}" (campaign ${campaign.id}, idempotent re-launch)`);
        adSetExternalId = existingAdSetId;
      } else {
        // credentials.country is the ad account's own advertising country. Without it the broad
        // fallback used to pin targeting to the US, which is how an INR account published ad sets
        // aimed at the United States.
        const baseTargeting = await resolveAudienceTargetingForWorkspace(workspaceId, audienceName, accessToken, credentials?.country);
        const targeting = await withAgentInterests(baseTargeting, campaign.metaInterests, accessToken);
        const adSet = await metaAdapter.createAdSetContainer!(
          {
            campaignExternalId,
            name: `${campaign.name} — ${audienceName}`,
            dailyBudgetCents: perVariantBudgetCents * groupVariants.length,
            budgetMode,
            objective: metaObjective,
            targeting,
            promotedObject: campaign.pixelId && campaign.conversionEvent ? { pixelId: campaign.pixelId, customEventType: campaign.conversionEvent } : undefined,
            startTime: campaign.startDate,
            endTime: campaign.endDate,
            advantagePlus: campaign.advantagePlus,
          },
          credentials
        );
        adSetExternalId = adSet.externalId;
      }

      // Stamp the ad set onto EVERY variant in the group up front — previously this only happened
      // after a variant's ad succeeded, which is exactly why a failed ad left no trace of the ad
      // set that had already been created and the retry couldn't find it.
      for (const variant of groupVariants) variant.adSetExternalId = adSetExternalId;

      for (const variant of groupVariants) {
        // Idempotency: a variant that already has a live externalId from a prior (partial) launch
        // is skipped — re-creating its ad would publish (and eventually spend on) a duplicate.
        if (variant.externalId && variant.status !== "failed") {
          logger.info(`launchMetaHierarchy: variant ${variant.id} already published as ${variant.externalId} — skipping (idempotent)`);
          continue;
        }
        try {
          // SVG/local creatives must be rasterized to PNG bytes — Meta can't fetch a localhost/
          // relative URL and rejects SVG (the "#100 url should represent a valid URL" launch failure).
          const uploadInput = await resolveMetaImageUpload(variant.creative.imageUrl, variant.creative.videoUrl);
          const upload = await metaAdapter.uploadCreativeAsset!(uploadInput, credentials);
          const result = await metaAdapter.createHierarchyAd!(
            {
              adSetExternalId,
              name: `${campaign.id}-${variant.id}`,
              creative: variant.creative,
              landingPageUrl: variant.landingPageUrl ?? campaign.finalUrl ?? "https://example.com",
              imageHash: upload.imageHash,
              videoId: upload.videoId,
              instagramActorId: campaign.instagramAccountId,
            },
            credentials
          );
          variant.externalId = result.externalId;
          variant.status = result.status;
          variant.failureReason = undefined; // clear any stale reason from a prior failed attempt
        } catch (err) {
          // Per-variant failure (creative upload or ad create) — the ad set survived, so only THIS
          // variant is lost. Log which one and why so a partial failure is diagnosable.
          logger.error(`launchMetaHierarchy: ad create failed for variant ${variant.id} in "${audienceName}" (campaign ${campaign.id})`, err);
          variant.status = "failed";
          variant.failureReason = launchFailureReason(err);
        }
      }
    } catch (err) {
      // Ad-set-level failure (targeting resolution or ad set create) fails the whole audience group.
      // On an INR/non-USD account this is where a below-minimum daily budget gets rejected — log the
      // Graph API message so the currency-minimum cause is visible instead of a silent group "Failed".
      logger.error(`launchMetaHierarchy: ad set failed for audience "${audienceName}" (campaign ${campaign.id}, budget ${perVariantBudgetCents * groupVariants.length} cents) — marking ${groupVariants.length} variants failed`, err);
      const reason = launchFailureReason(err);
      groupVariants.forEach((v) => { v.status = "failed"; v.failureReason = reason; });
    }
  }
}

/**
 * Builds the real Google Ads object graph for a shared group of variants: one Campaign
 * Budget + Campaign (geo/language targeting from the first audience group — Google
 * budgets/geo/language are campaign-level, unlike Meta's per-ad-set model), then one Ad
 * Group per distinct audience (age/gender/keyword criteria), then a Responsive Search Ad
 * per variant. Everything lands PAUSED, same safety default as Meta.
 */
async function launchGoogleHierarchy(
  campaign: Campaign,
  variants: CampaignVariant[],
  workspaceId: string,
  perVariantBudgetCents: number
): Promise<void> {
  // Same builder-selection override pattern as launchMetaHierarchy: the campaign builder lets a
  // user pick a specific Google Ads customer per campaign instead of always using the workspace's
  // default Integration connection.
  const applyCustomerOverride = (c?: GoogleAdsCredentials) =>
    c ? { ...c, customerId: campaign.googleCustomerId ?? c.customerId } : undefined;
  let credentials = applyCustomerOverride((await getGoogleAdsCredentials(workspaceId)) ?? undefined);

  // A stored Google access token can be dead while its recorded expiry still reads "in the future"
  // (e.g. the CRM manual-connect path stores an optimistic tokenExpiresAt) — so the normal refresh
  // gate never fires and the first live call 401s. Probe the first API call (campaign container),
  // and on an auth failure force a token refresh from the refresh token and retry ONCE. This runs
  // before any variant is persisted, so a clean top-of-hierarchy retry has no partial-state risk.
  const isAuthError = (err: unknown) => /\b401\b|UNAUTHENTICATED|invalid authentication/i.test(String((err as Error)?.message ?? err));

  const groups = new Map<string, CampaignVariant[]>();
  for (const variant of variants) {
    const key = variant.audienceName ?? "General Audience";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(variant);
  }
  const [firstAudienceName] = groups.keys();

  let accessToken = credentials?.accessToken ?? null;
  let developerToken = credentials?.developerToken ?? null;

  const buildContainer = async () => {
    // Locations collected directly in the builder take precedence over the SavedAudience-name
    // bridge (which strategy-generated variants without builder state still rely on).
    const campaignLevelGeoTargeting = campaign.locations?.length
      ? await buildGoogleCampaignTargetingFromLocations(accessToken, developerToken, campaign.locations)
      : (await resolveGoogleTargetingForWorkspace(workspaceId, firstAudienceName, accessToken, developerToken)).campaign;
    const conversionActionResourceName = credentials && campaign.googleConversionActionId
      ? `customers/${credentials.customerId}/conversionActions/${campaign.googleConversionActionId}`
      : undefined;
    return googleAdapter.createCampaignContainer!(
      { name: campaign.name, objective: "SEARCH", dailyBudgetCents: campaign.dailyBudgetCents, targeting: campaignLevelGeoTargeting, conversionActionResourceName },
      credentials
    );
  };

  let campaignExternalId: string;
  try {
    let container;
    try {
      container = await buildContainer();
    } catch (err) {
      // On an auth failure, mint a genuinely fresh token (bypassing the possibly-stale expiry gate)
      // and retry the container once. If it still fails, fall through to the outer catch.
      if (!isAuthError(err)) throw err;
      logger.warn(`launchGoogleHierarchy: auth error on first call for ${workspaceId} — force-refreshing token and retrying once`);
      credentials = applyCustomerOverride((await getGoogleAdsCredentials(workspaceId, { forceRefresh: true })) ?? undefined);
      accessToken = credentials?.accessToken ?? null;
      developerToken = credentials?.developerToken ?? null;
      container = await buildContainer();
    }
    campaignExternalId = container.externalId;
    campaign.externalIds = { ...campaign.externalIds, google: campaignExternalId };
  } catch (err) {
    // Top of the Google hierarchy (budget + campaign). Failure here fails EVERY variant — log the
    // real Ads API error (survives the auth-retry above), so a budget/targeting/token cause isn't
    // hidden behind a blanket "Failed".
    logger.error(`launchGoogleHierarchy: campaign container failed for ${campaign.id} — marking all ${variants.length} variants failed`, err);
    variants.forEach((v) => { v.status = "failed"; });
    return;
  }

  for (const [audienceName, groupVariants] of groups) {
    try {
      const targeting = await resolveGoogleTargetingForWorkspace(workspaceId, audienceName, accessToken, developerToken);
      const adGroup = await googleAdapter.createAdSetContainer!(
        {
          campaignExternalId,
          name: `${campaign.name} — ${audienceName}`,
          dailyBudgetCents: perVariantBudgetCents * groupVariants.length,
          targeting: withAgentKeywords(targeting.adGroup, campaign.googleKeywords),
        },
        credentials
      );

      for (const variant of groupVariants) {
        try {
          const result = await googleAdapter.createHierarchyAd!(
            {
              adSetExternalId: adGroup.externalId,
              name: `${campaign.id}-${variant.id}`,
              creative: variant.creative,
              landingPageUrl: variant.landingPageUrl ?? campaign.finalUrl ?? "https://example.com",
            },
            credentials
          );
          variant.externalId = result.externalId;
          variant.status = result.status;
          variant.adSetExternalId = adGroup.externalId;
        } catch (err) {
          // Per-variant failure (responsive search ad create) — the ad group survived, only THIS
          // variant is lost. Log which one and why.
          logger.error(`launchGoogleHierarchy: ad create failed for variant ${variant.id} in "${audienceName}" (campaign ${campaign.id})`, err);
          variant.status = "failed";
        }
      }
    } catch (err) {
      // Ad-group-level failure (targeting or ad group create) fails the whole audience group. Log the
      // Ads API message instead of a silent group "Failed".
      logger.error(`launchGoogleHierarchy: ad group failed for audience "${audienceName}" (campaign ${campaign.id}, budget ${perVariantBudgetCents * groupVariants.length} cents) — marking ${groupVariants.length} variants failed`, err);
      groupVariants.forEach((v) => { v.status = "failed"; });
    }
  }
}

/**
 * Launches every draft variant. Meta and Google variants go through their real object-graph
 * hierarchies (launchMetaHierarchy/launchGoogleHierarchy); TikTok keeps today's flat
 * per-variant launchVariant call until it gets the same depth in a follow-up.
 */
export async function launchCampaign(campaignId: string, workspaceId = "demo"): Promise<Campaign> {
  // Serialize launches of the same campaign across processes/requests. The idempotency guards in
  // launchMetaHierarchy/launchGoogleHierarchy prevent duplicate spend on a SEQUENTIAL re-launch,
  // but two launches racing concurrently could both read externalIds=∅ and both create a container
  // before either persists — the lock closes that window. Fail-fast (LockAlreadyHeldError) rather
  // than queue: a second concurrent launch of the same campaign is a double-submit, not real work.
  try {
    return await withLock(`launch:campaign:${campaignId}`, 5 * 60_000, () => launchCampaignInner(campaignId, workspaceId));
  } catch (err) {
    if (err instanceof LockAlreadyHeldError) {
      throw new Error(`Campaign ${campaignId} is already launching`);
    }
    throw err;
  }
}

async function launchCampaignInner(campaignId: string, workspaceId: string): Promise<Campaign> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  campaign.status = "launching";
  // Persisted so later reads (e.g. the scheduled metrics-ingestion worker, which only has a
  // campaignId to start from) know which workspace's Insight feed this campaign belongs to.
  campaign.workspaceId = workspaceId;
  const perVariantBudget = Math.floor(campaign.dailyBudgetCents / Math.max(campaign.variants.length, 1));

  const metaVariants = campaign.variants.filter((v) => v.network === "meta");
  const googleVariants = campaign.variants.filter((v) => v.network === "google");
  const otherVariants = campaign.variants.filter((v) => v.network !== "meta" && v.network !== "google");

  // Defense-in-depth: the campaign builders (buildCampaignFromStrategy / buildCampaignFromSuggestions)
  // already drop non-active networks, and the /campaigns/generate Zod boundary rejects them — so in
  // normal flow there are NO otherVariants here. This loop stays as a last-resort guard because
  // launchCampaign is also reachable via POST /campaigns/:id/launch on an arbitrary persisted
  // campaign (e.g. an older draft built before a network was gated). For any non-active network we
  // do NOT call its adapter, so it never gets an externalId and never spends; marked "skipped" so it
  // reads as visibly not-launched rather than silently failing or dragging the campaign to "failed".
  for (const variant of otherVariants) {
    variant.status = "skipped";
  }

  if (metaVariants.length) {
    await launchMetaHierarchy(campaign, metaVariants, workspaceId, perVariantBudget);
  }
  if (googleVariants.length) {
    await launchGoogleHierarchy(campaign, googleVariants, workspaceId, perVariantBudget);
  }

  // `networks` was previously frozen at strategy-creation time (buildCampaignFromStrategy),
  // so it could drift from reality once the builder added/removed per-network ads afterward —
  // e.g. still reading ["meta"] after a Google ad was added and published. Recomputed here
  // from actual variant outcomes so it never contradicts externalIds or the real launch
  // result, which matters for anything reading this field downstream (the CRM sync in
  // particular — see adsDataRoutes.ts's /ads-data/campaigns).
  // Excludes both "failed" and "skipped" variants: a skipped (coming-soon) network was never
  // launched and has no externalId, so reporting it here would reintroduce exactly the drift this
  // recompute exists to prevent (a network in the list that nothing downstream can act on).
  campaign.networks = [...new Set(campaign.variants.filter((v) => v.status !== "failed" && v.status !== "skipped").map((v) => v.network))];

  campaign.status = campaign.variants.some((v) => v.status === "active")
    ? "active"
    : campaign.variants.some((v) => v.status === "paused")
      ? "paused"
      : "failed";
  campaign.updatedAt = new Date().toISOString();
  await saveCampaign(campaign);

  // Mirror the launched platform hierarchy into the AdSet/Ad tables the Ads Manager reads, so a
  // published campaign's ads actually show up there (they're otherwise only on the campaign's
  // variants JSON + the ad network). Best-effort: a mirror failure must not fail the launch.
  try {
    await syncLaunchedHierarchy(campaign.id, campaign.workspaceId, campaign.variants as any);
  } catch (err) {
    logger.warn(`launchCampaign: failed to mirror launched hierarchy into Ads Manager tables for ${campaign.id}`, err);
  }

  // Seed the always-on safety guardrails ("fuse") for this workspace the moment a campaign goes
  // live, so absolute max-CPA / min-ROAS / spend-cap protection is active by default rather than
  // only when a user hand-creates rules. Idempotent + best-effort: never block or fail a launch on it.
  if (campaign.status !== "failed" && campaign.workspaceId) {
    try {
      await ensureFuseGuardrails(campaign.workspaceId);
    } catch (err) {
      logger.warn(`launchCampaign: failed to seed fuse guardrails for ${campaign.workspaceId}`, err);
    }
  }

  // Fire-and-forget: today's only subscriber just logs (see src/infra/eventHandlers.ts),
  // but this is the exact seam roadmap Phase 3 replaces with a Kafka producer once the
  // Analytics/Notification workers become separate consumers of "campaign.launched".
  await eventBus.publish<CampaignLaunchedEvent>("campaign.launched", {
    campaignId: campaign.id,
    businessId: campaign.businessId,
    activeVariants: campaign.variants.filter((v) => v.status === "active").length,
    totalVariants: campaign.variants.length,
  });

  return campaign;
}

export async function pauseVariant(campaignId: string, variantId: string): Promise<Campaign> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  const variant = campaign.variants.find((v) => v.id === variantId);
  if (!variant || !variant.externalId) throw new Error(`Variant ${variantId} not launched`);

  const credentials = variant.network === "meta" ? (await getMetaCredentials(campaign.workspaceId ?? "demo")) ?? undefined : undefined;
  await adapters[variant.network].pauseVariant(variant.externalId, credentials);
  variant.status = "paused";
  campaign.updatedAt = new Date().toISOString();
  await saveCampaign(campaign);
  return campaign;
}

/** Flips a launched-but-paused variant to active — the explicit "spend real money now" step. */
export async function activateVariant(campaignId: string, variantId: string): Promise<Campaign> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  const variant = campaign.variants.find((v) => v.id === variantId);
  if (!variant || !variant.externalId) throw new Error(`Variant ${variantId} not launched`);

  const credentials = variant.network === "meta" ? (await getMetaCredentials(campaign.workspaceId ?? "demo")) ?? undefined : undefined;

  if (variant.network === "meta") {
    // Meta only starts spending when the WHOLE chain is ACTIVE — activating the leaf ad while its
    // ad set or campaign is still PAUSED leaves delivery stalled at ADSET_PAUSED/CAMPAIGN_PAUSED and
    // silently spends nothing. The Graph API's status flip (POST /{id} {status:ACTIVE}) is uniform
    // across object types, so we activate parent-first — campaign → ad set → ad — so the leaf ad is
    // never live under a paused parent. IDs come from where the launch path stored them:
    // campaign.externalIds.meta (container), variant.adSetExternalId (ad set), variant.externalId (ad).
    const chain: Array<[label: string, id: string | undefined]> = [
      ["campaign", campaign.externalIds?.meta],
      ["ad set", variant.adSetExternalId],
      ["ad", variant.externalId],
    ];
    for (const [label, id] of chain) {
      if (!id) {
        // A flat/legacy variant (launchVariant path) has no ad-set/campaign container — activating
        // just the ad is the correct and only option there. Skip missing links rather than failing.
        logger.info(`activateVariant: no Meta ${label} id for variant ${variantId} — skipping (flat/legacy launch)`);
        continue;
      }
      await adapters.meta.activateVariant(id, credentials);
    }
  } else {
    await adapters[variant.network].activateVariant(variant.externalId, credentials);
  }

  variant.status = "active";
  campaign.updatedAt = new Date().toISOString();
  await saveCampaign(campaign);
  return campaign;
}

export async function reallocateBudget(campaignId: string, variantId: string, dailyBudgetCents: number): Promise<Campaign> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  const variant = campaign.variants.find((v) => v.id === variantId);
  if (!variant || !variant.externalId) throw new Error(`Variant ${variantId} not launched`);

  const credentials = variant.network === "meta" ? (await getMetaCredentials(campaign.workspaceId ?? "demo")) ?? undefined : undefined;
  const targetExternalId = variant.adSetExternalId ?? variant.externalId;
  await adapters[variant.network].setBudget({ externalId: targetExternalId, dailyBudgetCents }, credentials);
  campaign.updatedAt = new Date().toISOString();
  await saveCampaign(campaign);
  return campaign;
}

/**
 * Attaches AI-generated media (from creativeGenerationService) to every draft variant
 * that doesn't already have an image/video — a simplified bridge between the wizard's
 * one-generation-per-campaign flow and buildCampaignFromStrategy's per-network/per-creative
 * variants, which strategyEngine produces with text-only copy today.
 */
export async function applyCreativeMedia(campaignId: string, media: { imageUrl?: string; videoUrl?: string }): Promise<Campaign> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  for (const variant of campaign.variants) {
    if (media.imageUrl && !variant.creative.imageUrl) variant.creative.imageUrl = media.imageUrl;
    if (media.videoUrl && !variant.creative.videoUrl) variant.creative.videoUrl = media.videoUrl;
  }
  campaign.updatedAt = new Date().toISOString();
  await saveCampaign(campaign);
  return campaign;
}

export interface CampaignBuilderPatch {
  name?: string;
  dailyBudgetCents?: number;
  conversionEvent?: string;
  finalUrl?: string;
  startDate?: string;
  endDate?: string;
  locations?: string[];
  advantagePlus?: boolean;
  budgetMode?: "ABO" | "CBO";
  metaAdAccountId?: string;
  pageId?: string;
  instagramAccountId?: string;
  pixelId?: string;
  googleCustomerId?: string;
  googleConversionActionId?: string;
  variants?: CampaignVariant[];
  creativeAssets?: CreativeAssetRef[];
}

export async function updateCampaign(campaignId: string, patch: CampaignBuilderPatch): Promise<Campaign> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  if (patch.name !== undefined) campaign.name = patch.name;
  if (patch.dailyBudgetCents !== undefined) campaign.dailyBudgetCents = patch.dailyBudgetCents;
  if (patch.conversionEvent !== undefined) campaign.conversionEvent = patch.conversionEvent;
  if (patch.finalUrl !== undefined) campaign.finalUrl = patch.finalUrl;
  if (patch.startDate !== undefined) campaign.startDate = patch.startDate;
  if (patch.endDate !== undefined) campaign.endDate = patch.endDate;
  if (patch.locations !== undefined) campaign.locations = patch.locations;
  if (patch.advantagePlus !== undefined) campaign.advantagePlus = patch.advantagePlus;
  if (patch.budgetMode !== undefined) campaign.budgetMode = patch.budgetMode;
  if (patch.metaAdAccountId !== undefined) campaign.metaAdAccountId = patch.metaAdAccountId;
  if (patch.pageId !== undefined) campaign.pageId = patch.pageId;
  if (patch.instagramAccountId !== undefined) campaign.instagramAccountId = patch.instagramAccountId;
  if (patch.pixelId !== undefined) campaign.pixelId = patch.pixelId;
  if (patch.googleCustomerId !== undefined) campaign.googleCustomerId = patch.googleCustomerId;
  if (patch.googleConversionActionId !== undefined) campaign.googleConversionActionId = patch.googleConversionActionId;
  if (patch.variants !== undefined) campaign.variants = patch.variants;
  // Capped at 10 server-side, not just in the UI.
  if (patch.creativeAssets !== undefined) campaign.creativeAssets = patch.creativeAssets.slice(0, 10);
  campaign.updatedAt = new Date().toISOString();
  await saveCampaign(campaign);
  return campaign;
}

export { adapters };
