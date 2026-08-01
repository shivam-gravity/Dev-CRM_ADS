import { currentWorkspaceId } from "../lib/workspace.js";
const BASE_URL = "/api";

const LOOKS_INTERNAL = /prisma|stacktrace|\.(ts|js):\d+|at\s+\w+\s*\(/i;
const GENERIC_ERROR = "Something went wrong. Please try again.";

function firstFieldError(fieldErrors: Record<string, string[]>): string | null {
  const firstKey = Object.keys(fieldErrors)[0];
  return firstKey ? fieldErrors[firstKey][0] : null;
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error.length > 300 || LOOKS_INTERNAL.test(error) ? GENERIC_ERROR : error;
  }
  if (error && typeof error === "object" && "fieldErrors" in error) {
    return firstFieldError((error as { fieldErrors: Record<string, string[]> }).fieldErrors) ?? GENERIC_ERROR;
  }
  return GENERIC_ERROR;
}

export function getAccessToken(): string | null {
  return localStorage.getItem("polluxa_access_token");
}

export function getRefreshToken(): string | null {
  return localStorage.getItem("polluxa_refresh_token");
}

export function setTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem("polluxa_access_token", accessToken);
  localStorage.setItem("polluxa_refresh_token", refreshToken);
}

export function clearTokens(): void {
  localStorage.removeItem("polluxa_access_token");
  localStorage.removeItem("polluxa_refresh_token");
}

let refreshPromise: Promise<string | null> | null = null;

async function attemptTokenRefresh(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const rt = getRefreshToken();
    if (!rt) return null;
    try {
      const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      setTokens(data.accessToken, data.refreshToken);
      return data.accessToken as string;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

/** An Error carrying the server's HTTP status and machine-readable code, so a caller can tell a
 *  billing problem from a misconfiguration without inspecting the message text. */
export interface ApiError extends Error {
  status?: number;
  code?: string;
  billingUrl?: string;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  const token = getAccessToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res = await fetch(`${BASE_URL}${path}`, { ...options, headers });

  if (res.status === 401 && token) {
    const newToken = await attemptTokenRefresh();
    if (newToken) {
      headers["Authorization"] = `Bearer ${newToken}`;
      res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
    } else {
      clearTokens();
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
      throw new Error("Session expired");
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.error ? extractErrorMessage(body.error) : `Request failed: ${res.status}`) as ApiError;
    // Carried through so callers can act on the kind of failure rather than regexing the message.
    // 402 + code "PAYMENT" is the one publish failure the platform cannot fix for the user, and it
    // comes with a Meta billing link worth surfacing as a button.
    error.status = res.status;
    if (typeof body.code === "string") error.code = body.code;
    if (typeof body.billingUrl === "string") error.billingUrl = body.billingUrl;
    throw error;
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface User { id: string; email: string; name: string; avatar?: string; createdAt: string; }
export interface Workspace { id: string; name: string; ownerId: string; plan: "starter" | "pro" | "agency"; logoUrl?: string; timezone: string; createdAt: string; }
export interface WorkspaceMember { id: string; workspaceId: string; userId: string; role: "owner" | "admin" | "member" | "viewer"; invitedAt: string; joinedAt?: string; user?: { name: string; email: string; avatar?: string }; }
export interface BusinessProfile { id: string; workspaceId?: string; name: string; website?: string; industry: string; monthlyBudgetCents: number; goals: string[]; targetAudience?: string; brandName?: string; logoUrls?: string[]; }
export interface AdCreative { headline: string; body: string; callToAction: string; imageUrl?: string; videoUrl?: string; headlines?: string[]; primaryTexts?: string[]; }
export interface AdStrategy { id: string; businessId: string; summary: string; recommendedNetworks: ("meta" | "google")[]; budgetSplit: Record<string, number>; audiences: string[]; creatives: AdCreative[]; createdAt: string; }
// `failureReason` carries the ad network's own end-user error text (Meta's error_user_msg, via
// launchFailureReason in campaignOrchestrator). GET /campaigns/:id already returned it — it spreads
// the whole campaign `data` blob — but this interface omitted the field, so nothing in the web app
// could read it and every failed launch rendered as a bare "Failed" badge with no cause.
export interface CampaignVariant { id: string; creative: AdCreative; network: "meta" | "google" | "tiktok"; externalId?: string; status: string; audienceName?: string; landingPageUrl?: string; adSetExternalId?: string; failureReason?: string; }
export interface CreativeAssetRef { id: string; url: string; type: "image" | "video"; source: "ai" | "upload"; }
export interface Campaign {
  id: string; businessId: string; workspaceId?: string; strategyId: string; name: string; status: string;
  /** Per-workspace campaign number behind the "C-0007" reference shown throughout the UI and used
   * as the name prefix on the real Meta/Google objects. Absent on campaigns created before it existed. */
  seq?: number;
  /** URL slug, "c-0007-polluxa-traffic" — prefer it over `id` when building links (see campaignPath). */
  slug?: string;
  networks: ("meta" | "google")[]; dailyBudgetCents: number; variants: CampaignVariant[];
  objective?: string; autoOptimize?: boolean;
  createdAt: string; updatedAt: string;
  conversionEvent?: string; finalUrl?: string; startDate?: string; endDate?: string;
  locations?: string[]; advantagePlus?: boolean; budgetMode?: "ABO" | "CBO";
  /** Every audience segment the strategy produced, best-first — including the ones the daily budget
   *  could not fund. The campaign publishes one ad set per distinct variant audienceName; the rest
   *  are alternatives the builder can swap in. Undefined on campaigns built before this existed. */
  audiencePool?: string[];
  /** Target cost per lead/acquisition in cents. Drives the feasibility projection. */
  targetCpaCents?: number;
  /** Meta instant-form id — when set the campaign runs as a Lead Ad instead of driving to the site. */
  leadFormId?: string;
  metaAdAccountId?: string; pageId?: string; instagramAccountId?: string; pixelId?: string;
  googleCustomerId?: string; googleConversionActionId?: string;
  creativeAssets?: CreativeAssetRef[];
  externalIds?: { meta?: string; google?: string };
}
export interface CampaignBuilderPatch {
  name?: string; dailyBudgetCents?: number; conversionEvent?: string; finalUrl?: string;
  startDate?: string; endDate?: string; locations?: string[]; advantagePlus?: boolean; budgetMode?: "ABO" | "CBO";
  metaAdAccountId?: string; pageId?: string; instagramAccountId?: string; pixelId?: string;
  googleCustomerId?: string; googleConversionActionId?: string;
  /** Target cost per lead in cents. 0/undefined clears it and returns to the modelled estimate. */
  targetCpaCents?: number;
  /** Meta instant-form id; "" clears it and returns the campaign to driving to the website. */
  leadFormId?: string;
  variants?: CampaignVariant[]; creativeAssets?: CreativeAssetRef[];
}
export interface MetaAdAccount { id: string; name: string; currency: string; timezoneName?: string; accountStatus?: string; }
export interface MetaPage { id: string; name: string; }
/** An instant (lead-gen) form on the connected Page — attaching one collects leads inside Meta
 *  rather than driving to the website, which is what makes a small budget viable. */
export interface MetaLeadForm { id: string; name: string; status?: string; }
export interface MetaInstagramAccount { id: string; username: string; }
export interface MetaPixel { id: string; name: string; }
export interface GoogleCustomer { id: string; name: string; }
export interface GoogleConversionAction { id: string; name: string; category: string; }
export interface NormalizedPerformance {
  campaignId: string; variantId: string; network: "meta" | "google";
  impressions: number; reach: number; clicks: number; conversions: number; spendCents: number;
  ctr: number; cpaCents: number | null; cpmCents: number | null; cpcCents: number | null; roas: number | null; conversionRate: number;
}
export interface FunnelMetrics { addToCart: number; addPaymentInfo: number; purchases: number; purchaseValueCents: number; }
/** Per-network slice of a campaign's live metrics — one entry per network the campaign runs on,
 * so a dual-network campaign can be shown as separate Meta and Google rows. dailyBudgetCents is the
 * campaign's budget split proportionally by that network's live-variant count. */
export interface NetworkSlice {
  impressions: number; reach: number; clicks: number; conversions: number; spendCents: number; revenueCents: number;
  dailyBudgetCents: number; liveVariantCount: number;
  ctr: number; cpcCents: number | null; cpmCents: number | null; roas: number | null;
  funnel: FunnelMetrics;
  costPerAddToCartCents: number | null; costPerAddPaymentInfoCents: number | null; costPerPurchaseCents: number | null;
  addToCartRate: number | null; purchaseRate: number | null;
}
export interface LiveInsights {
  campaignId: string; isLive: boolean;
  impressions: number; reach: number; clicks: number; conversions: number; spendCents: number;
  ctr: number; cpcCents: number | null; cpmCents: number | null; roas: number | null;
  funnel?: FunnelMetrics;
  costPerAddToCartCents?: number | null; costPerAddPaymentInfoCents?: number | null; costPerPurchaseCents?: number | null;
  addToCartRate?: number | null; purchaseRate?: number | null;
  byNetwork?: Partial<Record<"meta" | "google", NetworkSlice>>;
}
export interface OptimizationDecision { campaignId: string; chosenVariantId: string; action: string; reason: string; decidedAt: string; }
export interface Invoice { id: string; businessId: string; periodStart: string; periodEnd: string; adSpendCents: number; platformFeeCents: number; totalCents: number; createdAt: string; }
export interface PaymentMethod { workspaceId: string; brand: "visa" | "mastercard" | "amex" | "discover" | "unknown"; last4: string; expiry: string; updatedAt: string; }

/** Connected Meta ad account's real billing snapshot (money amounts in the currency's MINOR unit). */
export interface MetaAccountFunding {
  adAccountId: string;
  currency: string;
  balanceMinor: number;
  amountSpentMinor: number;
  spendCapMinor: number | null;
  accountStatus?: string;
  fundingSource?: string;
  billingUrl: string;
}
export interface WalletBalance { workspaceId: string; balanceCents: number; currency: string; lastTopUpAt: string | null; updatedAt: string; }
export interface WalletTransaction { id: string; workspaceId: string; type: "top_up" | "ad_spend" | "refund" | "adjustment"; amountCents: number; balanceAfterCents: number; description: string; referenceId?: string; createdAt: string; }
/** Manage Funds payload: real Meta billing (or null if not connected) + the internal wallet ledger. */
export interface FundsSnapshot { meta: MetaAccountFunding | null; wallet: WalletBalance | null; transactions: WalletTransaction[]; }
export interface SupportTicket { id: string; workspaceId: string; subject: string; message: string; status: "open" | "resolved"; createdAt: string; }
export interface NotificationPreferences { emailAlerts: boolean; slackAlerts: boolean; digestAlerts: boolean; }
export type RbacMatrix = Record<string, Record<string, boolean>>;
export interface DeveloperWebhook { id: string; workspaceId: string; url: string; events: string[]; createdAt: string; }
export interface AutomationRule {
  id: string; workspaceId: string; name: string; metric: string; operator: "gt" | "lt" | "eq"; thresholdValue: number;
  action: string; actionParam?: string; cooldownMinutes: number; priority: "low" | "medium" | "high"; enabled: boolean;
  createdAt: string; updatedAt: string;
}
export interface OptimizationGoal { dailyBudgetCents: number; primaryKpi: string; locations: string[]; }
export interface ScrapedSite { url: string; title: string; description: string; excerpt: string; images: string[]; crawledPages: string[]; pagesDiscovered: number; screenshot?: string; }
export interface ProductAnalysis {
  productName: string; category: string; summary: string; valueProposition: string; keyFeatures: string[];
  businessType?: string; useCases?: { title: string; description: string }[]; pricingModel?: string; pricingRange?: string; dataSource?: string;
}
export interface AudienceAnalysis {
  primaryAudience: string; segments: { name: string; description: string }[]; painPoints: string[]; buyingMotivations: string[];
  demographics?: { ageDistribution: string; genderRatio: string; occupation: string };
  consumerCharacteristics?: string; interestTags?: string[]; recommendedObjective?: string; recommendedPerformanceGoal?: string; dataSource?: string;
}
export interface DeepResearchResult { site: ScrapedSite; product: ProductAnalysis; audience: AudienceAnalysis; }
export interface CompanyProfileData {
  overview: string; products: string[]; services: string[]; features: string[];
  pricing: string; industries: string[]; targetAudience: string;
  icp: { summary: string; segments: { name: string; description: string }[] };
  personas: { name: string; description: string }[];
  technology: string[]; positioning: string; messaging: string[];
  socialProof: string[]; faqs: { question: string; answer: string }[];
}
export interface CompanyProfileRecord { businessId: string; businessName: string; domain: string | null; data: CompanyProfileData; updatedAt: string; }

export interface Citation { url: string; title: string; }
export interface DeepResearchBlock<T = unknown> { key: string; label: string; citations: Citation[]; data: T; }
export interface CompetitorBudgetAnalysis { competitors: string[]; competitionIntensity: string; differentiators: string[]; budgetReasoning: string[]; recommendedDailyBudgetCents: number; dataSource: string; }
export interface MarketLocationAnalysis { recommendedRegion: string; alternativeRegions: string[]; marketTrends: string; keyDrivers?: string[]; competitionLevel: string; recommendedPlatform: "meta" | "google" | "tiktok"; placementRationale: string; dataSource: string; }
export interface AudiencePersona { name: string; ageRange: string; genderSplit: string; details: string; interests: string[]; }
export interface ResearchSessionResult { site: ScrapedSite; product: ProductAnalysis; audience: AudienceAnalysis; competitorBudget: CompetitorBudgetAnalysis; marketLocation: MarketLocationAnalysis; personas: AudiencePersona[]; }
export interface CampaignSuggestion {
  id: string;
  title: string;
  description: string;
  hashtags: string[];
  platform: "meta" | "google" | "tiktok";
  headline: string;
  body: string;
  callToAction: string;
  imagePrompt: string;
}
// ── Decision Intelligence (research/decision/*.ts on the backend) ─────────────────────────
export type RecommendationCategory = "positioning" | "audience" | "channel" | "budget" | "creative" | "offer" | "messaging";
export interface RankedRecommendation {
  id: string; title: string; category: RecommendationCategory; priority: string; impact: string;
  confidence: number; reason: string; evidence: string[]; affectedAudience: string;
  estimatedDifficulty: string; expectedOutcome: string; finalScore: number;
}
export interface CampaignStrategyOption {
  id: string; label: string; targetAudience: string; platforms: string[]; objective: string;
  budgetDailyCents: number; creativeDirection: string; messaging: string; offer: string;
  expectedKpi: string; strengths: string[]; weaknesses: string[]; confidence: number;
}
export interface StrategySimulationResult {
  strategyId: string; strategyLabel: string; reach: number; competition: number; expectedRoi: number;
  risk: number; confidence: number; budgetEfficiency: number; overallScore: number; rank: number;
}
export interface AudiencePersonaCard {
  name: string; description: string; ageRange?: string; genderSplit?: string; interests: string[];
}
export interface PricingTier {
  tier: string; priceRange: string; details: string;
}
export interface RegionalMarketDepth {
  region: string; marketSize?: string; growthRate?: string; policyDrivers: string[];
}
export interface DecisionContext {
  businessSummary: string; websiteScreenshot?: string; audiencePersonas: AudiencePersonaCard[];
  pricingTiers: PricingTier[]; notableCustomers: string[]; quantifiedProofPoints: string[];
  regionalMarketDepth: RegionalMarketDepth | null;
  topOpportunities: string[]; topRisks: string[];
  recommendedPositioning: string; recommendedAudiencePriority: string; recommendedChannels: string[];
  recommendedBudgetAllocation: Record<string, number>; recommendedDailyBudgetCents: number; budgetReasoning: string[];
  recommendedCreativeDirection: string;
  recommendedOffer: string; recommendedMessaging: string; confidence: number; evidence: string[];
  tradeoffs: string[]; recommendations: RankedRecommendation[]; strategies: CampaignStrategyOption[];
  simulations: StrategySimulationResult[]; generatedAt: string;
}
export type CampaignGenerationPipelineStatus = "pending" | "researching" | "aggregating" | "running_agents" | "building_campaign" | "completed" | "failed";

/** The subset of the backend ResearchContext the campaign UI streams in mid-run. All optional —
 * a field is null until its provider settles, so the preview fills in progressively. */
export interface ResearchContextLite {
  company?: { name?: string; summary?: string } | null;
  market?: { marketSummary?: string; opportunityScore?: number; recommendedRegion?: string } | null;
  audience?: { primaryAudience?: string; painPoints?: string[] } | null;
  competitors?: { competitors?: { name: string }[] } | null;
  metadata?: { overallConfidence?: number };
}

export interface CampaignGenerationJobStatus {
  id: string; status: CampaignGenerationPipelineStatus; researchJobId?: string; strategyId?: string;
  campaignId?: string; decisionContext: DecisionContext | null;
  error?: string;
  startedAt?: string; completedAt?: string; updatedAt: string;
  url?: string;
  /** When the underlying research was last run, and how fresh it still is (14-day horizon —
   * see apps/api/src/gateway/router.ts's CAMPAIGN_RESEARCH_FRESHNESS_TTL_MS) — lets the UI show
   * a "Researched N days ago" badge and prompt a refresh once it's gone stale. */
  researchedAt?: string;
  researchFreshness?: number;
  researchIsStale?: boolean;
}

/** One source-attributed fact extracted from the business's own website during generation. */
export interface VerifiedCampaignFact {
  field: string;
  value: string;
  confidence: number;
  sourceUrl: string | null;
  sourcePageType: string | null;
  sourcePageTitle: string | null;
}

export interface CampaignGenerationFacts {
  crawl: { url: string; pagesDiscovered: number; pagesCrawled: number } | null;
  facts: VerifiedCampaignFact[];
}

/** Real-time step names as they complete (research providers, then agents, then the
 * campaign build step) — backed by a short-lived Redis record, not a durable one; an old
 * or already-finished job will just return an empty `completedSteps`. */
export interface CampaignGenerationProgress {
  completedSteps: string[];
  total: number;
}

export interface CampaignObjectiveOption {
  value: string;
  label: string;
  description: string;
  /** Pixel conversion events Meta accepts for this objective; null = unconstrained. Served from
   *  metaObjectives.ts so a picker filters on the same rules the launch guard enforces. */
  conversionEvents?: string[] | null;
}

export interface BudgetSimulation {
  estImpressionsPerDay: number;
  estClicks: number;
  estConversions: number;
  estRoas: number;
  source: "heuristic";
}

export interface CompetitorAdEntry {
  platform: "meta" | "google";
  advertiserName: string;
  headline?: string;
  bodyText?: string;
  previewUrl?: string;
  sourceUrl: string;
}

export interface CompetitorAdsData {
  ads: CompetitorAdEntry[];
  dataSource: string;
}

/** AdLibraryProvider's real competitor ad list — the one field of this response the UI
 * still consumes (Competitor Ads card). */
export interface CampaignGenerationCitations {
  competitorAds: CompetitorAdsData | null;
}

export interface ResearchSession {
  id: string; workspaceId: string; businessId?: string; url: string;
  status: "queued" | "running" | "done" | "failed";
  currentStep?: string;
  blocks: DeepResearchBlock[];
  personas?: AudiencePersona[];
  campaignSuggestions?: CampaignSuggestion[];
  result?: ResearchSessionResult;
  error?: string;
  searchCount: number;
  cacheHit: boolean;
  createdAt: string; updatedAt: string;
}
export interface CreativeAsset { id: string; businessId: string; headline: string; body: string; callToAction: string; format: "text" | "image" | "video"; tags: string[]; createdAt: string; }
export interface CreativeVariation { headline: string; body: string; callToAction: string; angle: string; }
export interface TrendPoint { date: string; impressions: number; clicks: number; conversions: number; spendCents: number; ctr: number; }
export interface AnalyticsSummary { businessId: string; totalSpendCents: number; totalImpressions: number; totalClicks: number; totalConversions: number; avgCtr: number; avgCpc: number | null; roas: number | null; activeCampaigns: number; period: "all" | "month" | "week"; }
export interface AudienceSuggestion { name: string; description: string; estimatedReach: string; platforms: ("meta" | "google")[]; interests: string[]; demographics: string; painPoints: string[]; buyingIntent: "low" | "medium" | "high"; }
export interface StrategistChatMessage { role: "user" | "assistant"; content: string; }

export interface Notification { id: string; workspaceId: string; type: string; title: string; message: string; read: boolean; severity: "info" | "warning" | "success" | "error"; actionUrl?: string; createdAt: string; }
export interface Asset { id: string; workspaceId: string; name: string; type: "image" | "video" | "logo" | "font" | "template"; url: string; thumbnailUrl?: string; size: number; mimeType: string; tags: string[]; usageCount: number; width?: number; height?: number; createdAt: string; }
export interface Insight { id: string; workspaceId: string; type: "anomaly" | "recommendation" | "trend" | "opportunity"; category: "budget" | "audience" | "creative" | "placement"; title: string; description: string; metric?: string; change?: number; severity: "low" | "medium" | "high"; actionLabel?: string; actionUrl?: string; dismissed: boolean; createdAt: string; }
export interface Integration { id: string; workspaceId: string; platform: "meta" | "google" | "tiktok" | "shopify" | "pixel"; status: "connected" | "disconnected" | "error" | "pending"; accountName?: string; accountId?: string; permissions: string[]; settings: Record<string, unknown>; connectedAt?: string; errorMessage?: string; updatedAt: string; }
export interface SavedAudience { id: string; workspaceId: string; name: string; type?: "saved" | "custom" | "lookalike" | "interest_group"; platform?: "meta" | "google" | null; lookalikeSourceId?: string | null; metaCustomAudienceId?: string | null; ageMin: number; ageMax: number; gender: "all" | "male" | "female"; locations: string[]; interests: string[]; exclusions: string[]; estimatedReach?: string; createdAt: string; }
export interface ReachEstimate { usersLowerBound: number; usersUpperBound: number; source: "meta" | "heuristic"; }
export type ImageAspectRatio = "square" | "portrait" | "landscape";
export type ImageQuality = "standard" | "high";
export interface GenerationJobInput { businessId: string; productUrl?: string; prompt?: string; wantVideo: boolean; aspectRatio?: ImageAspectRatio; language?: string; quality?: ImageQuality; /** How many distinct angle-diverse creatives to produce in one job (standalone image jobs only). */ variantCount?: number; }
export interface GenerationCreativeVariant { creativeId: string; headline: string; body: string; callToAction: string; angle?: string; imageAssetId: string; imageUrl: string; videoAssetId?: string; videoUrl?: string; }
export interface GenerationJobResult { headline: string; body: string; callToAction: string; creativeId: string; imageAssetId: string; imageUrl: string; videoAssetId?: string; videoUrl?: string; /** Full multi-angle burst; index 0 mirrors the top-level fields. */ variants?: GenerationCreativeVariant[]; }
export interface GenerationJob { id: string; workspaceId: string; businessId: string; type: "image" | "video" | "full_creative"; status: "queued" | "running" | "done" | "failed"; input: GenerationJobInput; result?: GenerationJobResult; error?: string; createdAt: string; updatedAt: string; }
export type ProductCatalogSource = "shopify" | "facebook" | "google";
export interface ProductCatalogItem { id: string; source: ProductCatalogSource; name: string; category: string; priceCents: number; imageUrl: string; url: string; }
export interface CatalogSourceResult { source: ProductCatalogSource; connected: boolean; accountName?: string; items: ProductCatalogItem[]; }
export interface Draft { id: string; workspaceId: string; name: string; type: "campaign" | "ad_set" | "ad"; status: "draft" | "review" | "scheduled" | "published"; data: Record<string, unknown>; aiRecommendation?: string; score?: number; scheduledAt?: string; publishedAt?: string; createdAt: string; updatedAt: string; /** "campaign" = a draft-status Campaign surfaced on /drafts read-only (publish/edit/delete route to the campaign endpoints); "draft"/absent = a real Draft-table row. */ origin?: "draft" | "campaign"; }
export interface AdSet { id: string; campaignId: string; name: string; status: "active" | "paused" | "draft"; dailyBudgetCents: number; targeting: Record<string, unknown>; placements: string[]; bidStrategy: string; startDate?: string; endDate?: string; createdAt: string; updatedAt: string; }
export interface Ad { id: string; adSetId: string; name: string; status: "active" | "paused" | "draft" | "rejected"; creative: { headline: string; body: string; callToAction: string; imageUrl?: string }; format: "single_image" | "carousel" | "video" | "collection"; externalId?: string; createdAt: string; updatedAt: string; }

export type AdInsightNetwork = "meta" | "google" | "tiktok" | "bing";
export interface DistributionSlice { label: string; sharePct: number; }
export interface AudienceInsightItem { name: string; tags: string[]; cpaCents: number | null; spendCents: number; campaignCount: number; }
export interface PageInsightItem { url: string; cvr: number; spendCents: number; campaignCount: number; }
export interface CreativeInsightItem { id: string; headline: string; body: string; imageUrl?: string; ctr: number; cpaCents: number | null; campaignCount: number; }
export interface AdInsightsResponse {
  network: AdInsightNetwork;
  isDemo: boolean;
  totals: { spendCents: number; impressions: number; clicks: number; conversions: number; cpaCents: number | null; roas: number | null };
  audience: { distribution: DistributionSlice[]; top: AudienceInsightItem[] };
  pages: { distribution: DistributionSlice[]; top: PageInsightItem[] };
  creative: { scatter: { id: string; ctr: number; cpaCents: number }[]; topAds: CreativeInsightItem[] };
}

export interface AuthResponse { user: User; token: string; refreshToken: string; workspaceId?: string; businessId?: string; }
export interface CrmAuthResponse { user: User; accessToken: string; refreshToken: string; workspaceId: string; businessId: string; }

// ── API methods ───────────────────────────────────────────────────────────────
export const api = {
  // Auth
  login: (email: string, password: string) =>
    request<AuthResponse>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  register: (name: string, email: string, password: string) =>
    request<AuthResponse>("/auth/register", { method: "POST", body: JSON.stringify({ name, email, password }) }),
  googleAuth: (name: string, email: string, googleId: string) =>
    request<AuthResponse>("/auth/google", { method: "POST", body: JSON.stringify({ name, email, googleId }) }),
  crmLogin: (token: string) =>
    request<CrmAuthResponse>("/auth/crm-login", { method: "POST", body: JSON.stringify({ token }) }),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  me: () => request<User>("/auth/me"),
  updateMe: (patch: { name?: string; avatar?: string }) =>
    request<User>("/auth/me", { method: "PATCH", body: JSON.stringify(patch) }),

  // Workspaces
  getWorkspace: (id: string) => request<Workspace>(`/workspaces/${id}`),
  updateWorkspace: (id: string, patch: Partial<Omit<Workspace, "id" | "ownerId" | "createdAt">>) =>
    request<Workspace>(`/workspaces/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  listMembers: (workspaceId: string) => request<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`),
  inviteMember: (workspaceId: string, email: string, role: "admin" | "member" | "viewer") =>
    request<WorkspaceMember>(`/workspaces/${workspaceId}/members/invite`, { method: "POST", body: JSON.stringify({ email, role }) }),
  updateMemberRole: (memberId: string, role: string) =>
    request<WorkspaceMember>(`/workspaces/members/${memberId}/role`, { method: "PATCH", body: JSON.stringify({ role }) }),
  removeMember: (memberId: string) => request<void>(`/workspaces/members/${memberId}`, { method: "DELETE" }),

  // Notifications
  listNotifications: (workspaceId: string) => request<Notification[]>(`/workspaces/${workspaceId}/notifications`),
  unreadCount: (workspaceId: string) => request<{ count: number }>(`/workspaces/${workspaceId}/notifications/count`),
  markRead: (id: string) => request<Notification>(`/notifications/${id}/read`, { method: "PATCH" }),
  markAllRead: (workspaceId: string) => request<void>(`/workspaces/${workspaceId}/notifications/read-all`, { method: "POST" }),

  // Assets
  listAssets: (workspaceId: string, type?: Asset["type"]) =>
    request<Asset[]>(`/workspaces/${workspaceId}/assets${type ? `?type=${type}` : ""}`),
  createAsset: (workspaceId: string, input: Omit<Asset, "id" | "workspaceId" | "createdAt" | "usageCount">) =>
    request<Asset>(`/workspaces/${workspaceId}/assets`, { method: "POST", body: JSON.stringify(input) }),
  deleteAsset: (id: string) => request<void>(`/assets/${id}`, { method: "DELETE" }),
  uploadAsset: (workspaceId: string, input: { name: string; type: Asset["type"]; mimeType: string; dataBase64: string; tags?: string[]; width?: number; height?: number }) =>
    request<Asset>(`/workspaces/${workspaceId}/assets/upload`, { method: "POST", body: JSON.stringify(input) }),
  updateAssetTags: (id: string, tags: string[]) =>
    request<Asset>(`/assets/${id}/tags`, { method: "PATCH", body: JSON.stringify({ tags }) }),

  // AI Insights
  listInsights: (workspaceId: string, businessId?: string) =>
    request<Insight[]>(`/workspaces/${workspaceId}/insights${businessId ? `?businessId=${businessId}` : ""}`),
  generateInsights: (workspaceId: string, businessId: string) =>
    request<Insight[]>(`/workspaces/${workspaceId}/insights/generate?businessId=${businessId}`, { method: "POST" }),
  dismissInsight: (id: string) => request<Insight>(`/insights/${id}/dismiss`, { method: "PATCH" }),

  // Integrations
  startMetaOAuth: (workspaceId: string) => `${BASE_URL}/integrations/meta/oauth/start?workspaceId=${encodeURIComponent(workspaceId)}`,
  startGoogleOAuth: (workspaceId: string) => `${BASE_URL}/integrations/google/oauth/start?workspaceId=${encodeURIComponent(workspaceId)}`,
  listIntegrations: (workspaceId: string) => request<Integration[]>(`/workspaces/${workspaceId}/integrations`),
  connectIntegration: (workspaceId: string, platform: Integration["platform"], accountName: string) =>
    request<Integration>(`/workspaces/${workspaceId}/integrations/${platform}/connect`, { method: "POST", body: JSON.stringify({ accountName }) }),
  disconnectIntegration: (workspaceId: string, platform: Integration["platform"]) =>
    request<Integration>(`/workspaces/${workspaceId}/integrations/${platform}/disconnect`, { method: "POST" }),
  updateIntegrationSettings: (workspaceId: string, platform: Integration["platform"], settings: Record<string, unknown>) =>
    request<Integration>(`/workspaces/${workspaceId}/integrations/${platform}/settings`, { method: "PATCH", body: JSON.stringify(settings) }),
  connectMetaManual: (workspaceId: string, input: { accessToken: string; adAccountId: string; pageId?: string; pageAccessToken?: string }) =>
    request<Integration>(`/workspaces/${workspaceId}/integrations/meta/connect-manual`, { method: "POST", body: JSON.stringify(input) }),
  connectGoogleManual: (workspaceId: string, input: { customerId: string; developerToken: string; accessToken: string; clientId?: string; clientSecret?: string; refreshToken?: string }) =>
    request<Integration>(`/workspaces/${workspaceId}/integrations/google/connect-manual`, { method: "POST", body: JSON.stringify(input) }),
  listProductCatalog: (workspaceId: string, source: ProductCatalogSource | "all") =>
    request<CatalogSourceResult[]>(`/workspaces/${workspaceId}/products?source=${source}`),

  // Meta account/page/Instagram/pixel selectors for the campaign builder — full lists,
  // distinct from listIntegrations' single workspace-level connection.
  listMetaAdAccounts: (workspaceId: string) => request<MetaAdAccount[]>(`/workspaces/${workspaceId}/integrations/meta/ad-accounts`),
  listMetaPages: (workspaceId: string) => request<MetaPage[]>(`/workspaces/${workspaceId}/integrations/meta/pages`),
  listMetaInstagramAccounts: (workspaceId: string, pageId: string) =>
    request<MetaInstagramAccount[]>(`/workspaces/${workspaceId}/integrations/meta/pages/${pageId}/instagram-accounts`),
  /** `adAccountId` scopes the list to the account the campaign targets — pixels are owned per ad
   * account, and offering the workspace default's pixels for a campaign publishing elsewhere
   * guarantees a pairing Meta rejects. Omit for the workspace default. */
  listMetaPixels: (workspaceId: string, adAccountId?: string) =>
    request<MetaPixel[]>(`/workspaces/${workspaceId}/integrations/meta/pixels${adAccountId ? `?adAccountId=${encodeURIComponent(adAccountId)}` : ""}`),
  /** Instant (lead-gen) forms on the connected Page. Empty when Meta or the Page isn't connected —
   *  an empty picker is a valid answer, so this never rejects for that reason. */
  listMetaLeadForms: (workspaceId: string) =>
    request<{ forms: MetaLeadForm[] }>(`/workspaces/${workspaceId}/integrations/meta/lead-forms`),
  listGoogleCustomers: (workspaceId: string) => request<GoogleCustomer[]>(`/workspaces/${workspaceId}/integrations/google/customers`),
  listGoogleConversionActions: (workspaceId: string) => request<GoogleConversionAction[]>(`/workspaces/${workspaceId}/integrations/google/conversion-actions`),

  // Saved audiences
  listAudiences: (workspaceId: string) => request<SavedAudience[]>(`/workspaces/${workspaceId}/audiences`),
  createAudience: (workspaceId: string, input: Omit<SavedAudience, "id" | "workspaceId" | "createdAt" | "estimatedReach">) =>
    request<SavedAudience>(`/workspaces/${workspaceId}/audiences`, { method: "POST", body: JSON.stringify(input) }),
  deleteAudience: (id: string) => request<void>(`/audiences/${id}`, { method: "DELETE" }),
  // Create a real Meta Custom Audience (optionally seeded with a hashed customer list) — returned
  // SavedAudience carries metaCustomAudienceId, which lets a launched ad set target it.
  createCustomAudience: (workspaceId: string, input: { name: string; subtype?: "CUSTOM" | "WEBSITE" | "APP" | "OFFLINE" | "ENGAGEMENT"; description?: string; emails?: string[]; phones?: string[]; ageMin?: number; ageMax?: number; gender?: "all" | "male" | "female"; locations?: string[] }) =>
    request<SavedAudience>(`/workspaces/${workspaceId}/audiences/custom`, { method: "POST", body: JSON.stringify(input) }),
  // Create a Meta Lookalike from an existing source Custom Audience (must have a metaCustomAudienceId).
  createLookalike: (workspaceId: string, input: { name: string; sourceAudienceId: string; ratio?: number; targetCountries?: string[] }) =>
    request<SavedAudience>(`/workspaces/${workspaceId}/audiences/lookalike`, { method: "POST", body: JSON.stringify(input) }),
  getReachEstimate: (workspaceId: string, audienceId: string) =>
    request<ReachEstimate>(`/workspaces/${workspaceId}/audiences/${audienceId}/reach-estimate`, { method: "POST" }),
  getEphemeralReachEstimate: (workspaceId: string, input: { locations: string[]; interests?: string[]; ageMin?: number; ageMax?: number; gender?: "all" | "male" | "female" }) =>
    request<ReachEstimate>(`/workspaces/${workspaceId}/reach-estimate`, { method: "POST", body: JSON.stringify(input) }),

  // AI creative generation
  createGenerationJob: (workspaceId: string, input: GenerationJobInput) =>
    request<GenerationJob>(`/workspaces/${workspaceId}/generation-jobs`, { method: "POST", body: JSON.stringify(input) }),
  getGenerationJob: (id: string) => request<GenerationJob>(`/generation-jobs/${id}`),

  // Drafts
  listDrafts: (workspaceId: string) => request<Draft[]>(`/workspaces/${workspaceId}/drafts`),
  createDraft: (workspaceId: string, input: Pick<Draft, "name" | "type" | "data" | "aiRecommendation" | "score" | "scheduledAt">) =>
    request<Draft>(`/workspaces/${workspaceId}/drafts`, { method: "POST", body: JSON.stringify(input) }),
  updateDraft: (id: string, patch: Partial<Draft>) => request<Draft>(`/drafts/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  publishDraft: (id: string) => request<Draft>(`/drafts/${id}/publish`, { method: "POST" }),
  scheduleDraft: (id: string, scheduledAt: string) =>
    request<Draft>(`/drafts/${id}/schedule`, { method: "POST", body: JSON.stringify({ scheduledAt }) }),
  deleteDraft: (id: string) => request<void>(`/drafts/${id}`, { method: "DELETE" }),

  // Ad Sets & Ads
  listAdSets: (campaignId: string) => request<AdSet[]>(`/campaigns/${campaignId}/ad-sets`),
  createAdSet: (campaignId: string, input: Omit<AdSet, "id" | "campaignId" | "createdAt" | "updatedAt">) =>
    request<AdSet>(`/campaigns/${campaignId}/ad-sets`, { method: "POST", body: JSON.stringify(input) }),
  listAds: (adSetId: string) => request<Ad[]>(`/ad-sets/${adSetId}/ads`),
  createAd: (adSetId: string, input: Omit<Ad, "id" | "adSetId" | "createdAt" | "updatedAt">) =>
    request<Ad>(`/ad-sets/${adSetId}/ads`, { method: "POST", body: JSON.stringify(input) }),
  updateAd: (id: string, patch: Partial<Pick<Ad, "name" | "status" | "creative" | "format">>) =>
    request<Ad>(`/ads/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  // Onboarding
  scrapeWebsite: (url: string) => request<ScrapedSite>("/onboarding/scrape", { method: "POST", body: JSON.stringify({ url }) }),
  analyzeProduct: (site: ScrapedSite) =>
    request<ProductAnalysis>("/onboarding/analyze-product", { method: "POST", body: JSON.stringify(site) }),
  analyzeAudience: (site: ScrapedSite, product: ProductAnalysis) =>
    request<AudienceAnalysis>("/onboarding/analyze-audience", { method: "POST", body: JSON.stringify({ site, product }) }),
  deepResearch: (url: string) =>
    request<DeepResearchResult>("/onboarding/deep-research", { method: "POST", body: JSON.stringify({ url }) }),
  createResearchSession: (workspaceId: string, url: string, businessId?: string, force?: boolean) =>
    request<ResearchSession>(`/workspaces/${workspaceId}/research-sessions${force ? "?force=true" : ""}`, { method: "POST", body: JSON.stringify({ url, businessId }) }),
  getResearchSession: (id: string) => request<ResearchSession>(`/research-sessions/${id}`),
  // Full ResearchJob (incl. its aggregated ResearchContext). Used to stream the researched output
  // — company summary, market, audience, competitors — into the campaign UI DURING the run, since
  // research completes (~halfway) well before the decision engine produces the final strategy.
  getResearchJob: (id: string) => request<{ id: string; status: string; context: ResearchContextLite | null }>(`/research/${id}`),

  // Decision Intelligence campaign generation (Research Orchestrator -> Decision Engine
  // + AI Agent Coordinator -> Campaign Builder, all in one pipeline run — see
  // modules/orchestrator/campaignGenerationPipeline.ts)
  generateCampaign: (input: { workspaceId: string; businessId: string; url: string; name?: string; dailyBudgetCents?: number; channels?: string[]; objective?: string; countries?: string[]; forceRefresh?: boolean; deferBuild?: boolean }) =>
    request<CampaignGenerationJobStatus>("/campaigns/generate", { method: "POST", body: JSON.stringify(input) }),
  /** Finish a deferBuild run: writes the ads using the Promotion Objective selections. Idempotent. */
  buildGeneratedCampaign: (
    jobId: string,
    input: { objective?: string; dailyBudgetCents?: number; channels?: string[]; countries?: string[]; conversionEvent?: string; businessType?: string; promotionType?: string }
    // `warnings` are advisory notes about what this budget can realistically buy — how many
    // audiences it funds, the conversion event it can feed, the estimated cost per lead. Shown to
    // the user; never a failure.
  ) => request<Campaign & { campaignId: string; alreadyBuilt: boolean; warnings?: string[] }>(`/campaigns/generate/${jobId}/build`, { method: "POST", body: JSON.stringify(input) }),
  getCampaignGenerationStatus: (id: string) => request<CampaignGenerationJobStatus>(`/campaigns/generate/${id}/status`),
  getCampaignGenerationFacts: (id: string) => request<CampaignGenerationFacts>(`/campaigns/generate/${id}/facts`),
  getCampaignGenerationProgress: (id: string) => request<CampaignGenerationProgress>(`/campaigns/generate/${id}/progress`),
  getCampaignGenerationCitations: (id: string) => request<CampaignGenerationCitations>(`/campaigns/generate/${id}/citations`),
  // Materialize one of the 3 candidate strategies (by id "strategy-a" or label "Strategy A")
  // into an editable draft campaign — the results page's "pick one of 3 suggestions" action.
  selectCampaignStrategy: (jobId: string, strategy: string) =>
    request<Campaign & { campaignId: string; reusedWinner: boolean }>(`/campaigns/generate/${jobId}/select-strategy`, { method: "POST", body: JSON.stringify({ strategy }) }),
  // adsgo.ai-style flow: objective picker + interactive budget/goal simulator
  getCampaignObjectives: () => request<{ objectives: CampaignObjectiveOption[] }>("/campaigns/objectives"),
  simulateCampaign: (input: { objective?: string; dailyBudgetCents: number; platforms?: ("meta" | "google")[]; countries?: string[]; currency?: string }) =>
    request<BudgetSimulation>("/campaigns/simulate", { method: "POST", body: JSON.stringify(input) }),

  // Business
  createBusiness: (input: Omit<BusinessProfile, "id">) =>
    request<BusinessProfile>("/businesses", { method: "POST", body: JSON.stringify(input) }),
  listBusinesses: (workspaceId: string) => request<BusinessProfile[]>(`/businesses?workspaceId=${workspaceId}`),
  getBusiness: (id: string) => request<BusinessProfile>(`/businesses/${id}`),
  updateBusiness: (id: string, patch: Partial<Omit<BusinessProfile, "id">>) =>
    request<BusinessProfile>(`/businesses/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  getCompanyProfile: (businessId: string) => request<CompanyProfileRecord>(`/businesses/${businessId}/company-profile`),

  // Strategy
  generateStrategy: (businessId: string) =>
    request<AdStrategy>(`/businesses/${businessId}/strategies`, { method: "POST" }),
  createStrategyFromResearch: (businessId: string, researchSessionId: string) =>
    request<AdStrategy>(`/businesses/${businessId}/strategies/from-research`, { method: "POST", body: JSON.stringify({ researchSessionId }) }),
  listStrategies: (businessId: string) => request<AdStrategy[]>(`/businesses/${businessId}/strategies`),

  // Campaigns
  createCampaign: (input: { strategyId: string; name: string; dailyBudgetCents: number }) =>
    request<Campaign>("/campaigns", { method: "POST", body: JSON.stringify(input) }),
  listCampaigns: (businessId: string) => request<Campaign[]>(`/businesses/${businessId}/campaigns`),
  getCampaign: (id: string) => request<Campaign>(`/campaigns/${id}`),
  updateCampaign: (id: string, patch: CampaignBuilderPatch) =>
    request<Campaign>(`/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteCampaign: (id: string) => request<{ ok: true }>(`/campaigns/${id}`, { method: "DELETE" }),
  // Launch SPENDS MONEY through whichever workspace's ad-account token is named here, so the old
  // "demo-workspace" default was the worst place in the app to invent an id. Fails closed instead.
  launchCampaign: (id: string, workspaceId: string = currentWorkspaceId()) =>
    request<Campaign>(`/campaigns/${id}/launch`, { method: "POST", body: JSON.stringify({ workspaceId }) }),
  pauseVariant: (campaignId: string, variantId: string) =>
    request<Campaign>(`/campaigns/${campaignId}/variants/${variantId}/pause`, { method: "POST" }),
  activateVariant: (campaignId: string, variantId: string) =>
    request<Campaign>(`/campaigns/${campaignId}/variants/${variantId}/activate`, { method: "POST" }),
  reallocateBudget: (campaignId: string, variantId: string, dailyBudgetCents: number) =>
    request<Campaign>(`/campaigns/${campaignId}/variants/${variantId}/budget`, { method: "POST", body: JSON.stringify({ dailyBudgetCents }) }),
  applyCreativeMedia: (campaignId: string, media: { imageUrl?: string; videoUrl?: string }) =>
    request<Campaign>(`/campaigns/${campaignId}/apply-creative-media`, { method: "POST", body: JSON.stringify(media) }),
  ingestMetrics: (id: string) => request<unknown[]>(`/campaigns/${id}/ingest`, { method: "POST" }),
  getPerformance: (id: string) => request<NormalizedPerformance[]>(`/campaigns/${id}/performance`),
  getLiveInsights: (id: string, range?: string) =>
    request<LiveInsights>(`/campaigns/${id}/live-insights${range ? `?range=${encodeURIComponent(range)}` : ""}`),
  getCampaignTrend: (id: string) => request<TrendPoint[]>(`/campaigns/${id}/trend`),
  optimize: (id: string) => request<OptimizationDecision[]>(`/campaigns/${id}/optimize`, { method: "POST" }),
  setAutoOptimize: (id: string, enabled: boolean) =>
    request<{ id: string; autoOptimize: boolean }>(`/campaigns/${id}/auto-optimize`, { method: "POST", body: JSON.stringify({ enabled }) }),

  // Analytics
  getAnalyticsSummary: (businessId: string, period: "all" | "month" | "week" = "all") =>
    request<AnalyticsSummary>(`/businesses/${businessId}/analytics/summary?period=${period}`),
  getAudienceSuggestions: (businessId: string) =>
    request<AudienceSuggestion[]>(`/businesses/${businessId}/audience-suggestions`),
  getAdInsights: (businessId: string, network: AdInsightNetwork = "meta") =>
    request<AdInsightsResponse>(`/businesses/${businessId}/ad-insights?network=${network}`),
  chatWithStrategist: (businessId: string, messages: StrategistChatMessage[]) =>
    request<{ reply: string }>(`/businesses/${businessId}/strategist/chat`, { method: "POST", body: JSON.stringify({ messages }) }),
  chatWithCopilot: (businessId: string, messages: StrategistChatMessage[]) =>
    request<{ reply: string }>(`/businesses/${businessId}/copilot/chat`, { method: "POST", body: JSON.stringify({ messages }) }),

  // Creatives
  listCreatives: (businessId: string) => request<CreativeAsset[]>(`/businesses/${businessId}/creatives`),
  createCreative: (businessId: string, input: { headline: string; body: string; callToAction: string; format?: "text" | "image" | "video"; tags?: string[] }) =>
    request<CreativeAsset>(`/businesses/${businessId}/creatives`, { method: "POST", body: JSON.stringify(input) }),
  deleteCreative: (id: string) => request<void>(`/creatives/${id}`, { method: "DELETE" }),
  generateCreativeVariations: (base: { headline: string; body: string; callToAction: string }) =>
    request<CreativeVariation[]>("/creatives/variations", { method: "POST", body: JSON.stringify(base) }),

  // Billing
  generateInvoice: (businessId: string, periodStart: string, periodEnd: string) =>
    request<Invoice>(`/businesses/${businessId}/invoices`, { method: "POST", body: JSON.stringify({ periodStart, periodEnd }) }),
  listInvoices: (businessId: string) => request<Invoice[]>(`/businesses/${businessId}/invoices`),
  getPaymentMethod: (workspaceId: string) => request<PaymentMethod | null>(`/workspaces/${workspaceId}/payment-method`),
  setPaymentMethod: (workspaceId: string, input: { cardNumber: string; expiry: string; cvc: string }) =>
    request<PaymentMethod>(`/workspaces/${workspaceId}/payment-method`, { method: "PUT", body: JSON.stringify(input) }),
  getFunds: (workspaceId: string) => request<FundsSnapshot>(`/workspaces/${workspaceId}/funds`),

  // Support tickets
  listSupportTickets: (workspaceId: string) => request<SupportTicket[]>(`/workspaces/${workspaceId}/support-tickets`),
  createSupportTicket: (workspaceId: string, input: { subject: string; message: string }) =>
    request<SupportTicket>(`/workspaces/${workspaceId}/support-tickets`, { method: "POST", body: JSON.stringify(input) }),

  // Notification preferences
  getNotificationPreferences: (workspaceId: string) => request<NotificationPreferences>(`/workspaces/${workspaceId}/notification-preferences`),
  setNotificationPreferences: (workspaceId: string, prefs: NotificationPreferences) =>
    request<NotificationPreferences>(`/workspaces/${workspaceId}/notification-preferences`, { method: "PUT", body: JSON.stringify(prefs) }),

  // RBAC role matrix
  getRbacMatrix: (workspaceId: string) => request<RbacMatrix>(`/workspaces/${workspaceId}/rbac-matrix`),
  setRbacMatrix: (workspaceId: string, matrix: RbacMatrix) =>
    request<RbacMatrix>(`/workspaces/${workspaceId}/rbac-matrix`, { method: "PUT", body: JSON.stringify(matrix) }),

  // Developer portal
  listDeveloperWebhooks: (workspaceId: string) => request<DeveloperWebhook[]>(`/workspaces/${workspaceId}/developer/webhooks`),
  createDeveloperWebhook: (workspaceId: string, input: { url: string; events: string[] }) =>
    request<DeveloperWebhook>(`/workspaces/${workspaceId}/developer/webhooks`, { method: "POST", body: JSON.stringify(input) }),
  deleteDeveloperWebhook: (id: string) => request<void>(`/developer/webhooks/${id}`, { method: "DELETE" }),
  getDeveloperApiKey: (workspaceId: string) => request<{ key: string; createdAt: string }>(`/workspaces/${workspaceId}/developer/api-key`),
  regenerateDeveloperApiKey: (workspaceId: string) =>
    request<{ key: string; createdAt: string }>(`/workspaces/${workspaceId}/developer/api-key/regenerate`, { method: "POST" }),

  // Automation rules
  listAutomationRules: (workspaceId: string) => request<AutomationRule[]>(`/workspaces/${workspaceId}/automation-rules`),
  createAutomationRule: (workspaceId: string, input: Omit<AutomationRule, "id" | "workspaceId" | "createdAt" | "updatedAt" | "enabled">) =>
    request<AutomationRule>(`/workspaces/${workspaceId}/automation-rules`, { method: "POST", body: JSON.stringify(input) }),
  deleteAutomationRule: (id: string) => request<void>(`/automation-rules/${id}`, { method: "DELETE" }),

  // Optimization goal (Optimize Goal page's budget/KPI section)
  getOptimizationGoal: (workspaceId: string) => request<OptimizationGoal>(`/workspaces/${workspaceId}/optimization-goal`),
  setOptimizationGoal: (workspaceId: string, goal: OptimizationGoal) =>
    request<OptimizationGoal>(`/workspaces/${workspaceId}/optimization-goal`, { method: "PUT", body: JSON.stringify(goal) }),
};
