import type { Citation } from "../../types/index.js";
import type { KnowledgeFusionReport } from "../knowledge/KnowledgeFusionEngine.js";

/**
 * The new parallel-provider research pipeline's own type surface — deliberately
 * separate from apps/api/src/types/index.ts's ProductAnalysis/AudienceAnalysis/etc,
 * which belong to the existing sequential ResearchSession pipeline
 * (modules/onboarding/marketResearch.ts) and keep working unchanged. `Citation` is
 * the one type reused as-is since a {url, title} source pair means the same thing
 * in both pipelines.
 */

export type ResearchProviderStatus = "success" | "partial" | "failed";

export type ResearchJobStatus = "pending" | "running" | "aggregating" | "completed" | "failed";

/** One evidence/source entry a provider surfaced — persisted 1:1 into ResearchEvidence rows. */
export interface ResearchEvidenceItem {
  url: string;
  title?: string;
  snippet?: string;
}

/** Everything a provider needs to run — deliberately minimal and derived only from
 * the job itself, never from another provider's output, so providers stay independent
 * and runnable in any order (or dropped/added) without a dependency graph to maintain. */
export interface ResearchProviderInput {
  jobId: string;
  workspaceId: string;
  businessId?: string;
  url: string;
  businessName?: string;
  industry?: string;
  /** The REAL text content of the target site, crawled once up-front by the orchestrator
   * (before the provider fan-out) and passed to every provider. Providers that reason about
   * the business (company, audience, market, pricing, …) use this as the PRIMARY source of
   * truth about what the business actually is, so they describe the real site the user entered
   * instead of confabulating from an ambiguous business name + noisy web-search snippets — the
   * root cause of "the summary describes a totally different company" hallucinations. Optional:
   * absent when the up-front crawl fails/returns nothing, in which case providers fall back to
   * their prior search-only behavior. Already refined (boilerplate stripped) and length-capped. */
  websiteExcerpt?: string;
  /** Source-attributed facts extracted ONCE up-front from the crawled site (fact → URL →
   * confidence), the core of the fact-first pipeline. Business-identity providers reason from
   * these in a single structured call instead of each running its own web search + LLM
   * structuring — collapsing ~17 retrieval calls into one shared extraction, which cuts token
   * use / free-tier throttling and raises grounding (every claim is pinned to a real page).
   * Empty when the up-front crawl/extraction produced nothing; providers then use their
   * search path as before. */
  verifiedFacts?: { field: string; value: string; sourceUrl?: string; confidence: number }[];
}

/** Uniform envelope every provider returns, regardless of what T is — the orchestrator
 * and knowledge aggregator only ever deal in ProviderResult<T>, never a provider's raw
 * internals, so adding/removing providers never touches orchestration code. */
export interface ProviderResult<T> {
  provider: string;
  status: ResearchProviderStatus;
  data: T | null;
  citations: Citation[];
  evidence: ResearchEvidenceItem[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  attempt: number;
  error?: string;
  /** 0-1 — how much a downstream consumer (an AI Agent, a human reviewing the research)
   * should trust this specific result. Computed once, generically, in runProviderStep
   * (see providers/support.ts) from signals every provider already reports (status,
   * evidence count, retry count, whether `data.dataSource` is a real citation vs. the
   * two known no-live-data fallback strings) — never provider-specific logic, so adding
   * a 10th provider gets confidence scoring for free. */
  confidence: number;
}

/* ─────────────────────────────  Per-provider data shapes  ───────────────────────────── */

export interface WebsiteData {
  title: string;
  description: string;
  excerpt: string;
  images: string[];
  crawledPages: string[];
  pagesDiscovered: number;
  screenshot?: string;
  dataSource: string;
  /** CrawlJob row id when page-level persistence ran (requires input.businessId) — lets
   * downstream fact extraction attach CrawlFact rows to this crawl's pages. Undefined when
   * the crawl ran without a business context or persistence failed non-fatally. */
  crawlJobId?: string;
}

export interface GeneralSearchData {
  narrative: string;
  searchesUsed: number;
  dataSource: string;
}

export interface TechnologyData {
  cms?: string;
  ecommercePlatform?: string;
  analyticsTools: string[];
  frameworks: string[];
  hostingProvider?: string;
  detectedFrom: string[];
  dataSource: string;
}

export interface CompanyData {
  name: string;
  summary: string;
  foundedYear?: string;
  headquarters?: string;
  employeeRange?: string;
  fundingStage?: string;
  /** Best-effort estimate (e.g. "$5M-$10M ARR") — from public signals (funding, headcount,
   * pricing x estimated customer count), never a confident/exact figure. */
  revenueEstimate?: string;
  /** e.g. "Cloud/SaaS (multi-tenant)", "Self-hosted/on-prem", "Hybrid" */
  deploymentModel?: string;
  /** e.g. "Per-seat subscription", "Usage-based", "Freemium + paid tiers" */
  pricingModel?: string;
  /** Business-level tech stack the company builds on/integrates with (distinct from
   * TechnologyData, which is the *website's own* fingerprinted CMS/analytics/hosting). */
  technologyStack?: string[];
  /** Named integrations/ecosystem partners the product connects with. */
  integrations?: string[];
  /** e.g. "Self-serve/PLG", "Inside sales", "Enterprise/field sales" */
  salesMotion?: string;
  /** How a customer typically moves from trial/first purchase to renewal/expansion. */
  customerLifecycle?: string;
  dataSource: string;
}

export interface MarketData {
  marketSize?: string;
  growthRate?: string;
  trends: string[];
  recommendedRegion?: string;
  competitionLevel: string;
  /** Compound Annual Growth Rate, as stated/estimated in research, e.g. "14.2% CAGR (2024-2029)" */
  cagr?: string;
  /** Total Addressable Market size, e.g. "$42B globally" */
  tam?: string;
  /** Per-region demand breakdown — distinct from the single `recommendedRegion` summary
   * string above, which stays as the one-line takeaway. */
  geographicDemand?: { region: string; demandLevel: string; notes?: string }[];
  dataSource: string;
}

export interface CompetitorEntry {
  name: string;
  url?: string;
  notes?: string;
  /** e.g. "~15% of named-competitor set" or "Unknown — no market-share data found" */
  marketShare?: string;
  /** Best-effort estimate of this competitor's ad spend, e.g. "$50K-$100K/mo (estimated)" */
  estimatedAdBudget?: string;
  /** How this competitor differentiates itself from the rest of the field. */
  differentiation?: string;
}

export interface CompetitorData {
  competitors: CompetitorEntry[];
  competitionIntensity: string;
  differentiators: string[];
  dataSource: string;
}

export interface AudienceSegmentData {
  name: string;
  description: string;
  /** This segment's OWN channels — distinct per role (e.g. an engineer and a CFO are
   * reached differently). Optional so older/cached segments without it still degrade
   * cleanly to AudienceData.interestTags at the consumer (decision-engine.ts). */
  interests?: string[];
}

export interface AudienceData {
  primaryAudience: string;
  segments: AudienceSegmentData[];
  painPoints: string[];
  interestTags: string[];
  demographics?: { ageDistribution: string; genderRatio: string };
  /** Roles typically involved in the buying decision, each with their relative influence —
   * distinct from a flat decision-maker list: this is *who's in the room*, not just titles. */
  buyingCommittee?: { role: string; influence: string }[];
  /** How the buying committee's roles relate/report to each other for this kind of purchase. */
  decisionHierarchy?: string;
  /** The role that actually controls/signs off on budget for this kind of purchase. */
  budgetOwner?: string;
  /** Typical steps/duration from first evaluation to signed deal. */
  procurementCycle?: string;
  /** Events/situations that prompt someone to start looking for this kind of product. */
  buyingTriggers?: string[];
  /** The typical stages a buyer moves through from first awareness to becoming a customer,
   * each with what's actually happening/needed at that stage. */
  customerJourney?: { stage: string; description: string }[];
  dataSource: string;
}

export interface SEOData {
  primaryKeywords: string[];
  metaTitle?: string;
  metaDescription?: string;
  headings: string[];
  dataSource: string;
}

export interface NewsArticle {
  title: string;
  url: string;
  snippet?: string;
}

export interface NewsData {
  articles: NewsArticle[];
  summary: string;
  dataSource: string;
}

/* ─────────────────────────  11 additional research dimensions  ───────────────────────── */

export interface SocialMediaPlatformPresence {
  platform: string;
  handle?: string;
  followers?: string;
  engagementLevel?: string;
}

export interface SocialMediaData {
  platforms: SocialMediaPlatformPresence[];
  overallPresence: string;
  dataSource: string;
}

export interface ReviewsData {
  averageRating?: string;
  totalReviewsEstimate?: string;
  topPraise: string[];
  topComplaints: string[];
  reviewSources: string[];
  dataSource: string;
}

export interface FundingData {
  totalRaised?: string;
  latestRound?: string;
  investors: string[];
  valuation?: string;
  fundingTimeline: string[];
  dataSource: string;
}

export interface HiringSignalsData {
  openRolesEstimate?: string;
  growthSignal: string;
  keyDepartmentsHiring: string[];
  dataSource: string;
}

export interface ContentMarketingData {
  hasActiveBlog: boolean;
  publishingCadence?: string;
  contentPillars: string[];
  contentGaps: string[];
  dataSource: string;
}

export interface BacklinkAuthorityData {
  domainAuthorityEstimate?: string;
  notableBacklinkSources: string[];
  seoStrengthSummary: string;
  dataSource: string;
}

export interface AppStoreData {
  hasApp: boolean;
  platforms: string[];
  ratingSummary?: string;
  categoryRanking?: string;
  dataSource: string;
}

export interface VideoPresenceData {
  hasYoutubeChannel: boolean;
  subscriberEstimate?: string;
  contentThemes: string[];
  engagementSummary: string;
  dataSource: string;
}

export interface LocalPresenceData {
  hasLocalPresence: boolean;
  googleBusinessRating?: string;
  locationsEstimate?: string;
  localSeoNotes: string[];
  dataSource: string;
}

export interface PartnershipData {
  integrations: string[];
  partners: string[];
  ecosystemSummary: string;
  dataSource: string;
}

export interface LegalRegulatoryData {
  applicableRegulations: string[];
  industrySpecificRisks: string[];
  complianceSummary: string;
  dataSource: string;
}

/* ─────────────────────────  Firecrawl-backed crawler batch  ───────────────────────── */

export interface ProductEntry {
  name: string;
  priceText?: string;
  features: string[];
  availability?: string;
}

export interface ProductData {
  products: ProductEntry[];
  dataSource: string;
}

export interface NavigationPage {
  url: string;
  title?: string;
  pageType: string;
  discovered: boolean;
}

export interface NavigationData {
  pages: NavigationPage[];
  totalDiscovered: number;
  dataSource: string;
}

export interface SearchRankingEntry {
  query: string;
  position: number;
  title: string;
  url: string;
}

export interface SearchRankingData {
  rankings: SearchRankingEntry[];
  dataSource: string;
}

export interface AdLibraryEntry {
  platform: "meta" | "google";
  advertiserName: string;
  headline?: string;
  bodyText?: string;
  previewUrl?: string;
  sourceUrl: string;
}

export interface AdLibraryData {
  ads: AdLibraryEntry[];
  dataSource: string;
}

export interface AutocompleteData {
  suggestions: string[];
  dataSource: string;
}

export interface SerpFeaturesData {
  peopleAlsoAsk: string[];
  relatedSearches: string[];
  dataSource: string;
}

export interface CommunityDiscussionThread {
  title: string;
  url?: string;
  sentiment: string;
}

export interface CommunityDiscussionData {
  threads: CommunityDiscussionThread[];
  summary: string;
  dataSource: string;
}

/* ─────────────────────────────  Aggregated context  ───────────────────────────── */

export interface ResearchContextMetadata {
  jobId: string;
  generatedAt: string;
  totalDurationMs: number;
  providersSucceeded: string[];
  providersPartial: string[];
  providersFailed: string[];
  generalSearch?: GeneralSearchData;
  /** Per-provider confidence (0-1), keyed by provider name — lets a downstream AI Agent
   * or the UI weight/flag low-confidence fields (e.g. an AI-estimate competitor list with
   * no real citations) instead of treating every provider's output as equally trustworthy. */
  confidenceByProvider: Record<string, number>;
  /** Decision-relevance-WEIGHTED mean of confidenceByProvider across every provider that ran —
   * one number for "how much should I trust this research overall". Core identity providers
   * (company/website/audience/market/competitor/product/seo) weigh ×3, rarely-applicable ones ×0.3,
   * and a hard-failed provider's 0 is collapsed to ~0.05 weight so one flaky timeout can't crater an
   * otherwise-strong run. See computeOverallConfidence in knowledge/KnowledgeAggregator.ts. */
  overallConfidence: number;
  /** Knowledge Fusion Engine output (research/knowledge/KnowledgeFusionEngine.ts) —
   * authority-weighted confidence, cross-provider conflict detection, and a per-provider
   * explainability trail. Optional/additive: nothing that reads confidenceByProvider/
   * overallConfidence above needs to change. */
  fusion?: KnowledgeFusionReport;
}

/**
 * The strongly-typed deliverable of the whole pipeline (Knowledge Aggregator's output,
 * "AI Agents" input) — one field per provider except SearchProvider, whose output is a
 * cross-cutting narrative folded into `metadata.generalSearch` rather than its own field,
 * since it doesn't correspond to one of the named research dimensions the caller asked for.
 */
export interface ResearchContext {
  jobId: string;
  workspaceId: string;
  businessId?: string;
  url: string;
  website: WebsiteData | null;
  market: MarketData | null;
  technology: TechnologyData | null;
  competitors: CompetitorData | null;
  keywords: SEOData | null;
  audience: AudienceData | null;
  company: CompanyData | null;
  news: NewsData | null;
  /** These 11 fields are optional (unlike the original 8 above, which are always-present-
   * but-possibly-null) specifically so every existing ResearchContext test fixture across
   * the codebase keeps compiling unchanged — genuinely additive, not just in spirit. New
   * code should still treat a missing field the same as an explicit null (provider hasn't
   * run / data not available), never assume presence. */
  socialMedia?: SocialMediaData | null;
  reviews?: ReviewsData | null;
  funding?: FundingData | null;
  hiringSignals?: HiringSignalsData | null;
  contentMarketing?: ContentMarketingData | null;
  backlinkAuthority?: BacklinkAuthorityData | null;
  appStore?: AppStoreData | null;
  videoPresence?: VideoPresenceData | null;
  localPresence?: LocalPresenceData | null;
  partnerships?: PartnershipData | null;
  legalRegulatory?: LegalRegulatoryData | null;
  /** Firecrawl-backed crawler batch — same "optional, additive" convention as the 11 fields
   * above, for the same reason (existing ResearchContext fixtures keep compiling unchanged). */
  product?: ProductData | null;
  navigation?: NavigationData | null;
  searchRanking?: SearchRankingData | null;
  adLibrary?: AdLibraryData | null;
  autocomplete?: AutocompleteData | null;
  serpFeatures?: SerpFeaturesData | null;
  communityDiscussion?: CommunityDiscussionData | null;
  metadata: ResearchContextMetadata;
}
