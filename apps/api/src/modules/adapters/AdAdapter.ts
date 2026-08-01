import type { AdCreative, AdNetwork, CampaignVariant, AdInsightStats } from "../../types/index.js";
import type { GoogleAdsCredentials } from "../integrations/googleOAuth.js";

export interface LaunchVariantInput {
  campaignId: string;
  variantId: string;
  creative: AdCreative;
  dailyBudgetCents: number;
  audience?: string;
}

export interface LaunchVariantResult {
  externalId: string;
  status: CampaignVariant["status"];
}

export interface SetBudgetInput {
  externalId: string;
  dailyBudgetCents: number;
}

export interface AdAdapter {
  readonly network: AdNetwork;
  launchVariant(input: LaunchVariantInput, credentials?: MetaCredentials): Promise<LaunchVariantResult>;
  pauseVariant(externalId: string, credentials?: MetaCredentials): Promise<void>;
  activateVariant(externalId: string, credentials?: MetaCredentials): Promise<void>;
  setBudget(input: SetBudgetInput, credentials?: MetaCredentials): Promise<void>;
  // Credentials are network-specific: Meta variants pass MetaCredentials, Google variants pass
  // GoogleAdsCredentials. The union keeps the shared AdAdapter type honest while each adapter's
  // own resolveCredentials narrows to the shape it needs.
  fetchInsights(externalId: string, date: string, credentials?: MetaCredentials | GoogleAdsCredentials): Promise<AdInsightStats>;
}

/**
 * Credentials for a workspace's connected Meta ad account (see integrationService.getMetaCredentials).
 * Optional on every hierarchy method below: when omitted, metaAdapter falls back to the
 * global META_ACCESS_TOKEN/META_AD_ACCOUNT_ID env vars, then to mock IDs if neither is set —
 * same three-tier fallback the rest of the adapters already use.
 */
export interface MetaCredentials {
  accessToken: string;
  adAccountId: string;
  pageId?: string;
  /** Ad account's billing currency — Meta's minor-unit conversion varies by currency (see metaAdapter's divisor table). */
  currency: string;
}

export interface CampaignContainerInput {
  name: string;
  /** Meta: campaign objective enum (e.g. OUTCOME_TRAFFIC). Google: ignored, channel type is fixed. */
  objective: string;
  /** Meta budget placement. "ABO" (default) = each ad set carries its own daily_budget; "CBO" =
   *  Campaign Budget Optimization, budget + bid_strategy live on the campaign and Meta distributes
   *  spend across ad sets. Google is always campaign-level regardless. */
  budgetMode?: "ABO" | "CBO";
  /** Campaign-level daily budget. Google: always used. Meta: used ONLY when budgetMode==="CBO". */
  dailyBudgetCents?: number;
  /** Google only: campaign-level geo/language criteria (from the first audience group — see googleTargetingMapper). */
  targeting?: Record<string, unknown>;
  /** Google only, set by the campaign builder — full resource name (customers/{id}/conversionActions/{id}) attached as a CampaignConversionGoal after creation. Best-effort: Search-campaign conversion-goal mutations have real API constraints, so a failure here doesn't fail the whole launch. */
  conversionActionResourceName?: string;
}

export interface AdSetContainerInput {
  campaignExternalId: string;
  name: string;
  /** Meta: this ad set's daily budget (ABO). Google: informational only — budget already set on the
   *  campaign. Ignored by Meta when budgetMode==="CBO" (budget lives on the campaign then). */
  dailyBudgetCents: number;
  /** Meta budget placement, threaded from the campaign. When "CBO" the ad set omits its own
   *  daily_budget + bid_strategy so Meta's campaign-level budget governs distribution. */
  budgetMode?: "ABO" | "CBO";
  targeting: Record<string, unknown>;
  /** Meta only, set by the campaign builder — conversion event tied to a Pixel. Switches optimization_goal to OFFSITE_CONVERSIONS when present. */
  promotedObject?: { pixelId: string; customEventType: string };
  /** Meta only, ISO date strings from the campaign builder's Schedule field. */
  startTime?: string;
  endTime?: string;
  /** Meta only — maps to targeting_automation.advantage_audience. */
  advantagePlus?: boolean;
  /** Frequency cap: max impressions per user within a time window. */
  frequencyCap?: {
    maxImpressions: number;
    intervalDays: number; // 1 = daily, 7 = weekly
  };
  /** Campaign-level objective — used to derive ad-set optimization_goal. */
  objective?: string;
  /**
   * Meta only — explicit optimization_goal, overriding what the objective would imply.
   *
   * Set by the orchestrator from budgetStructure's event ladder: optimising for a conversion the
   * budget cannot produce ~50 of per week keeps the ad set in the learning phase forever, so a
   * small budget is deliberately stepped down to a cheaper, reachable event
   * (LANDING_PAGE_VIEWS / LINK_CLICKS). Omit to keep the objective-derived default.
   */
  optimizationGoal?: string;
  /**
   * Meta instant-form (Lead Ad) id. Switches the ad set to on-Meta lead collection:
   * optimization_goal LEAD_GENERATION, destination_type ON_AD, and promoted_object `{ page_id }`
   * rather than a pixel — there is no website conversion to optimise for. Leads arrive through the
   * existing leadgen webhook.
   */
  leadGenFormId?: string;
  /** Page that owns the instant form — Meta's promoted_object for LEAD_GENERATION. */
  pageId?: string;
}

export interface CreativeUploadInput {
  imageUrl?: string;
  videoUrl?: string;
  /** Meta only — base64 PNG/JPEG bytes to upload directly (POST /adimages `bytes`) instead of a
   *  URL. Used when the creative is a locally-stored / SVG image Meta can't fetch by URL: the
   *  launch path rasterizes the SVG and passes the PNG bytes here. Takes precedence over imageUrl. */
  imageBytesBase64?: string;
}

export interface CreativeUploadResult {
  imageHash?: string;
  videoId?: string;
}

export interface HierarchyAdInput {
  adSetExternalId: string;
  name: string;
  creative: AdCreative;
  landingPageUrl: string;
  imageHash?: string;
  videoId?: string;
  /** Meta only, set by the campaign builder — publishes the ad to this Instagram business account alongside the Page. */
  instagramActorId?: string;
  /** Meta instant-form id. Makes the CTA open Meta's own lead form in-app instead of opening the
   *  landing page, so the lead never leaves Facebook/Instagram. Must match the ad set's
   *  leadGenFormId — Meta rejects a lead-form creative on a non-LEAD_GENERATION ad set. */
  leadGenFormId?: string;
}

/**
 * Optional real object-graph path (Campaign -> Ad Set/Ad Group -> Creative -> Ad) for
 * networks that support it. metaAdapter and googleAdapter implement this; tiktok stays on
 * the flat launchVariant path above until it gets the same depth in a follow-up.
 * Credentials are typed `unknown` here (each concrete adapter narrows to its own shape —
 * MetaCredentials vs GoogleAdsCredentials — since method-shorthand params are checked
 * bivariantly, this is a safe way to share one interface across differently-shaped adapters).
 */
export interface HierarchyCapableAdapter {
  createCampaignContainer?(input: CampaignContainerInput, credentials?: unknown): Promise<{ externalId: string }>;
  createAdSetContainer?(input: AdSetContainerInput, credentials?: unknown): Promise<{ externalId: string }>;
  uploadCreativeAsset?(input: CreativeUploadInput, credentials?: unknown): Promise<CreativeUploadResult>;
  createHierarchyAd?(input: HierarchyAdInput, credentials?: unknown): Promise<LaunchVariantResult>;
}
