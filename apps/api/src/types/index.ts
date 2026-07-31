export type AdNetwork = "meta" | "google" | "tiktok";

export interface ScrapedSite {
  url: string;
  title: string;
  description: string;
  excerpt: string;
  images: string[];
  crawledPages: string[];
  /** Total same-site pages found during discovery (sitemap.xml, or same-origin links on the homepage as a fallback) — always >= crawledPages.length, since only the top-scored subset gets actually fetched. */
  pagesDiscovered: number;
  /** Above-the-fold JPEG screenshot (data URI) from the Playwright-backed scraper-service, when reachable — undefined if that service is down or the page failed to render. */
  screenshot?: string;
  /** Per-page records (one per crawledPages entry) — kept alongside the flattened `excerpt`
   * above so callers that need page-level granularity (crawl persistence, fact provenance)
   * don't have to re-derive it from the flattened text. Optional because ScrapedSite also
   * doubles as the API payload shape for /onboarding/analyze-* routes, whose clients send
   * only the flattened fields. */
  pages?: ScrapedPage[];
}

export interface ScrapedPage {
  url: string;
  title: string;
  /** best-effort classification derived from the URL path, e.g. "homepage" | "pricing" | "product" | "about" | "other" */
  pageType: string;
  /** Sitemap priority blended with FOLLOW_HINTS path/text scoring — see discoverAndSelectPages in scraper.ts */
  relevanceScore: number;
  cleanedText: string;
  html: string;
}

export interface ProductAnalysis {
  productName: string;
  category: string;
  summary: string;
  valueProposition: string;
  keyFeatures: string[];
  /** Fields below are only populated by the deep-research pipeline (marketResearch.ts) — undefined from the plain analyzeProduct() path. */
  businessType?: string;
  /** Distinct real-world scenarios where this product/service gets used — undefined from the scrapegraphai fallback path, which has no equivalent field. */
  useCases?: { title: string; description: string }[];
  pricingModel?: string;
  pricingRange?: string;
  /** Real named clients/case studies/"trusted by" logos found on the site or via search —
   * empty array (not undefined) when none were found, so the frontend can distinguish "we
   * checked and found none" from "this field predates notableCustomers". Undefined only from
   * the scrapegraphai fallback path (no equivalent field there). */
  notableCustomers?: string[];
  /** Human-readable source citation for the "💡 Data Source" line — real citation titles when web search found sources, an honest "AI estimate" label otherwise (never a fabricated report name). */
  dataSource?: string;
}

export interface AudienceSegment {
  name: string;
  description: string;
}

export interface AudienceAnalysis {
  primaryAudience: string;
  segments: AudienceSegment[];
  painPoints: string[];
  buyingMotivations: string[];
  demographics?: { ageDistribution: string; genderRatio: string; occupation: string };
  consumerCharacteristics?: string;
  interestTags?: string[];
  recommendedObjective?: string;
  recommendedPerformanceGoal?: string;
  dataSource?: string;
}

export interface Citation {
  url: string;
  title: string;
}

export interface DeepResearchBlock<T = unknown> {
  key: string;
  label: string;
  citations: Citation[];
  data: T;
}

export interface CompetitorBudgetAnalysis {
  competitors: string[];
  competitionIntensity: string;
  differentiators: string[];
  budgetReasoning: string[];
  recommendedDailyBudgetCents: number;
  /** How/when to scale past the initial recommendation, e.g. "grow to $X/day once CPL
   * beats $Y and MQL-to-SQL exceeds Z%" — undefined from the scrapegraphai fallback path. */
  scaleUpGuidance?: string;
  dataSource: string;
}

export interface MarketLocationAnalysis {
  recommendedRegion: string;
  alternativeRegions: string[];
  marketTrends: string;
  /** Specific forces driving marketTrends — undefined from the scrapegraphai fallback path, which has no equivalent field. */
  keyDrivers?: string[];
  competitionLevel: string;
  recommendedPlatform: AdNetwork;
  placementRationale: string;
  dataSource: string;
}

export interface AudiencePersona {
  name: string;
  ageRange: string;
  genderSplit: string;
  details: string;
  interests: string[];
}

export type ProductCatalogSource = "shopify" | "facebook" | "google" | "woocommerce";

export interface ProductCatalogItem {
  id: string;
  source: ProductCatalogSource;
  name: string;
  category: string;
  priceCents: number;
  imageUrl: string;
  url: string;
}

export interface BusinessProfile {
  id: string;
  /** Owning workspace — the Prisma `Business.workspaceId` column, surfaced here so every
   * caller that already has a BusinessProfile can resolve its workspace without a second
   * query. Optional only for businesses that predate workspace scoping. */
  workspaceId?: string;
  name: string;
  website?: string;
  industry: string;
  monthlyBudgetCents: number;
  goals: string[];
  targetAudience?: string;
  /** Set via the deep-research "Brand Info" confirm card — distinct from `name` since a business record may predate branding being confirmed. */
  brandName?: string;
  logoUrls?: string[];
}

export interface AdCreative {
  headline: string;
  body: string;
  callToAction: string;
  imageUrl?: string;
  videoUrl?: string;
  /** Up to 5 headline/primary-text variants for the campaign builder's Ad Copy panel — `headline`/`body` above stay the first entry for back-compat with callers that don't know about variants. */
  headlines?: string[];
  primaryTexts?: string[];
  /** Google Responsive Search Ad description assets (≤90 chars each, distinct from Meta's 125-char
   * `primaryTexts`). Up to 4 per RSA — populated for Google variants so the adapter can publish a
   * full multi-asset RSA (5 headlines × 4 descriptions) rather than synthesizing from one pair.
   * Undefined for creatives built without a CreativeAgent result / non-Google flows. */
  descriptions?: string[];
}

export interface AdStrategy {
  id: string;
  businessId: string;
  summary: string;
  recommendedNetworks: AdNetwork[];
  budgetSplit: Partial<Record<AdNetwork, number>>;
  audiences: string[];
  creatives: AdCreative[];
  createdAt: string;
  /** Set only when ComplianceAgent found medium/high-risk issues — surfaced so a strategy
   * with real ad-policy concerns isn't silently discarded the way it was before this field
   * existed. Undefined (not just omitted-and-low) for strategies built without a
   * ComplianceAgent result at all, e.g. older pipelines/tests. */
  complianceWarning?: {
    risk: "medium" | "high";
    flags: { severity: "low" | "medium" | "high"; issue: string; suggestion: string }[];
    recommendation: string;
  };
  /** Set only when CriticAgent's adversarial review scored below the quality threshold or
   * raised issues — advisory only (never gates/fails the build), mirroring complianceWarning
   * above. Undefined for strategies built without a CriticAgent result at all (older
   * pipelines/tests) or when the review was clean. */
  qualityWarning?: {
    score: number;
    issues: { agent: string; severity: "low" | "medium" | "high"; issue: string }[];
    missingData: string[];
    recommendation: string;
  };
  /** Google Search-only keyword strategy from KeywordAgent — positive keywords merge into the
   * ad-group's keyword criteria at launch, negatives become negative criteria (see
   * googleTargetingMapper.withAgentKeywords). Undefined without a KeywordAgent result; the Meta
   * path never reads it. adGroupSuggestions is deliberately not carried. */
  googleKeywords?: { primary: string[]; negative: string[] };
  /** Meta-only free-text interest terms from persona-agent (interests) + audience-agent
   * (interestTags), resolved to Meta interest IDs and merged into the ad set's flexible_spec at
   * launch (see metaTargetingMapper.withAgentInterests). Undefined without those agents; the
   * Google path never reads it. Persona demographics parsing is deliberately not carried. */
  metaInterests?: string[];
}

/** One of 6+ distinct campaign angles generated from a completed research session — the user
 * picks one (optionally generating a real image/video for it first) before it becomes an
 * actual AdStrategy/Campaign via createStrategyFromSuggestion. */
export interface CampaignSuggestion {
  id: string;
  /** Short internal label for the suggestion card, e.g. "Social proof — Feed". */
  title: string;
  /** 1-2 sentence pitch shown on the card. */
  description: string;
  hashtags: string[];
  platform: AdNetwork;
  headline: string;
  body: string;
  callToAction: string;
  /** Fed into the creative-generation job's `prompt` field when the user generates media for this suggestion. */
  imagePrompt: string;
}

export type CampaignStatus = "draft" | "launching" | "active" | "paused" | "completed" | "failed" | "skipped";

export interface CampaignVariant {
  id: string;
  creative: AdCreative;
  network: AdNetwork;
  externalId?: string;
  status: CampaignStatus;
  audienceName?: string;
  landingPageUrl?: string;
  /** Ad Set-level external id for hierarchy-launched variants (see metaAdapter.createAdSetContainer) — budget lives here, not on the leaf ad. */
  adSetExternalId?: string;
  /** Human-readable reason set when status === "failed" — the network's own end-user error message
   * (e.g. Meta's error_user_msg) so the UI can show WHY a variant failed instead of a bare "Failed".
   * Only present on failure; cleared implicitly when a variant is (re)launched successfully. */
  failureReason?: string;
}

export interface CreativeAssetRef {
  id: string;
  url: string;
  type: "image" | "video";
  source: "ai" | "upload";
}

export interface Campaign {
  id: string;
  businessId: string;
  /** Set once the campaign is launched through a specific workspace (see launchCampaign) — used to route AI-generated insights (see optimizationEngine's recordOptimizationInsights) to the right workspace's feed. Undefined for campaigns that haven't been launched yet. */
  workspaceId?: string;
  strategyId: string;
  name: string;
  /**
   * Per-workspace sequential number behind the human-readable reference "C-0007"
   * (modules/orchestrator/campaignNaming.ts). Drives the Meta object names, the creative storage
   * path, and the URL slug, so one number identifies a campaign in Ads Manager, on disk, and in a
   * link. Optional: campaigns created before this existed have none and fall back to their UUID.
   */
  seq?: number;
  /**
   * URL slug, "c-0007-polluxa-traffic". Stored rather than derived so a rename cannot silently
   * change a campaign's address; resolution keys on the leading ref, so old links keep working.
   */
  slug?: string;
  status: CampaignStatus;
  networks: AdNetwork[];
  dailyBudgetCents: number;
  variants: CampaignVariant[];
  /** Meta campaign objective (post-ODAX key, e.g. OUTCOME_TRAFFIC/OUTCOME_LEADS/OUTCOME_SALES),
   * chosen in the generation flow and threaded through to launchMetaHierarchy so the real Meta
   * Campaign container uses it instead of the old hardcoded OUTCOME_TRAFFIC default. Optional:
   * campaigns generated before this existed (or via the manual builder) fall back to the default. */
  objective?: string;
  /** Persistent 24/7 auto-optimize switch. When explicitly false, the scheduled metrics worker
   * still ingests metrics but skips the budget-moving optimization pass for this campaign.
   * Undefined defaults to enabled (prior always-on behavior). Set via POST /campaigns/:id/auto-optimize. */
  autoOptimize?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Fields below are only set by the manual campaign builder (CampaignBuilder.tsx) — undefined for campaigns created via the /wizard instant-generate flow, which keeps working off getMetaCredentials' workspace-level default connection. */
  conversionEvent?: string;
  finalUrl?: string;
  startDate?: string;
  endDate?: string;
  locations?: string[];
  advantagePlus?: boolean;
  /** Meta budget placement. Undefined/"ABO" (default) = each ad set carries its own daily budget;
   * "CBO" = Campaign Budget Optimization (Advantage Campaign Budget), a single daily budget on the
   * campaign that Meta distributes across ad sets. Only meaningful for multi-ad-set (multi-audience)
   * Meta campaigns; threaded through launchMetaHierarchy. */
  budgetMode?: "ABO" | "CBO";
  metaAdAccountId?: string;
  pageId?: string;
  instagramAccountId?: string;
  pixelId?: string;
  googleCustomerId?: string;
  googleConversionActionId?: string;
  /** Capped at 10 — enforced where assets are appended, not just in the UI. */
  creativeAssets?: CreativeAssetRef[];
  /** Google Search-only keyword sets from KeywordAgent, threaded strategy -> build -> launch
   * (see launchGoogleHierarchy). Undefined for campaigns built without a KeywordAgent result,
   * and ignored entirely by the Meta path (keywords aren't a Meta concept). */
  googleKeywords?: { primary: string[]; negative: string[] };
  /** Meta-only free-text interest terms from persona/audience agents, threaded strategy -> build
   * -> launch (see launchMetaHierarchy). Resolved to Meta interest IDs at launch; ignored by Google. */
  metaInterests?: string[];
  /**
   * Real per-platform campaign-level IDs, set once launchMetaHierarchy/launchGoogleHierarchy
   * actually create the campaign container on that network — grouped under one object
   * (rather than separate top-level metaCampaignId/googleCampaignId fields) so later
   * CRM-sync work (leads, insights, audiences, webhooks) can extend this same shape with
   * more per-platform IDs without accumulating flat fields on Campaign each time.
   */
  externalIds?: {
    meta?: string;
    google?: string;
  };
}

export interface PerformanceMetric {
  id: string;
  campaignId: string;
  variantId: string;
  network: AdNetwork;
  date: string;
  impressions: number;
  /** Unique-user reach — real distinct metric on Meta; Google Search has no native per-ad reach, so it's estimated (see adapter comments). */
  reach: number;
  clicks: number;
  conversions: number;
  spendCents: number;
  /** Real purchase/conversion value reported by the ad network (Meta action_values,
   * Google metrics.conversions_value), in cents. 0 when the network reports no value. */
  revenueCents: number;
}

/**
 * Lower-funnel conversion counts + value, broken out by step. Meta reports these as separate
 * action_type rows in `actions`/`action_values` (add_to_cart, add_payment_info, purchase); Google
 * exposes analogous conversion-action segments. Cost-per-step and step CVR are derived downstream
 * from these counts + spend/clicks rather than stored, so they never drift out of sync.
 */
export interface FunnelMetrics {
  addToCart: number;
  addPaymentInfo: number;
  purchases: number;
  /** Real purchase value (cents) — same figure that feeds revenueCents/ROAS, kept here for the funnel column. */
  purchaseValueCents: number;
}

/** What every adapter's fetchInsights returns: the persisted per-day metric fields (minus the
 * identity/date columns the caller fills in) plus optional funnel breakdown when the network
 * reports it. Optional so adapters that can't segment the funnel simply omit it. */
export type AdInsightStats = Omit<PerformanceMetric, "id" | "campaignId" | "variantId" | "network" | "date"> & {
  funnel?: FunnelMetrics;
};

export interface NormalizedPerformance {
  campaignId: string;
  variantId: string;
  network: AdNetwork;
  impressions: number;
  reach: number;
  clicks: number;
  conversions: number;
  spendCents: number;
  /** Sum of real reported conversion value (cents) across this variant's metrics. */
  revenueCents: number;
  ctr: number;
  cpaCents: number | null;
  cpmCents: number | null;
  cpcCents: number | null;
  /** True ROAS = revenueCents / spendCents, from real network-reported conversion value. */
  roas: number | null;
  conversionRate: number;
}

export interface OptimizationDecision {
  campaignId: string;
  chosenVariantId: string;
  action: "increase_budget" | "decrease_budget" | "pause" | "hold" | "regenerate_creative" | "pause_audience";
  reason: string;
  decidedAt: string;
}

export interface Invoice {
  id: string;
  businessId: string;
  periodStart: string;
  periodEnd: string;
  adSpendCents: number;
  platformFeeCents: number;
  totalCents: number;
  createdAt: string;
}

export interface CreativeAsset {
  id: string;
  businessId: string;
  headline: string;
  body: string;
  callToAction: string;
  format: "text" | "image" | "video";
  tags: string[];
  createdAt: string;
  imageAssetId?: string;
  imageUrl?: string;
  videoAssetId?: string;
  videoUrl?: string;
}

export interface TrendPoint {
  date: string;
  impressions: number;
  clicks: number;
  conversions: number;
  spendCents: number;
  ctr: number;
}

export interface AnalyticsSummary {
  businessId: string;
  totalSpendCents: number;
  totalImpressions: number;
  totalClicks: number;
  totalConversions: number;
  avgCtr: number;
  avgCpc: number | null;
  roas: number | null;
  activeCampaigns: number;
  period: "all" | "month" | "week";
}

export interface AudienceSuggestion {
  name: string;
  description: string;
  estimatedReach: string;
  platforms: AdNetwork[];
  interests: string[];
  demographics: string;
  painPoints: string[];
  buyingIntent: "low" | "medium" | "high";
}

/* Ad Insights */

export type AdInsightNetwork = AdNetwork | "tiktok" | "bing";

export interface DistributionSlice {
  label: string;
  sharePct: number;
}

export interface AudienceInsightItem {
  name: string;
  tags: string[];
  cpaCents: number | null;
  spendCents: number;
  campaignCount: number;
}

export interface PageInsightItem {
  url: string;
  cvr: number;
  spendCents: number;
  campaignCount: number;
}

export interface CreativeInsightItem {
  id: string;
  headline: string;
  body: string;
  imageUrl?: string;
  ctr: number;
  cpaCents: number | null;
  campaignCount: number;
}

export interface AdInsightsResponse {
  network: AdInsightNetwork;
  isDemo: boolean;
  /** Network-scoped aggregates for the Ads Manager overview's stat tiles. */
  totals: {
    spendCents: number;
    impressions: number;
    clicks: number;
    conversions: number;
    cpaCents: number | null;
    /** True ROAS = real reported revenue / spend. */
    roas: number | null;
  };
  audience: {
    distribution: DistributionSlice[];
    top: AudienceInsightItem[];
  };
  pages: {
    distribution: DistributionSlice[];
    top: PageInsightItem[];
  };
  creative: {
    scatter: { id: string; ctr: number; cpaCents: number }[];
    topAds: CreativeInsightItem[];
  };
}
