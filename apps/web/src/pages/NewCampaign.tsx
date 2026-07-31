import { campaignPath, campaignPathById } from "../lib/campaignRef.js";
import { currentWorkspaceId } from "../lib/workspace.js";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { useRealtimeContext } from "../providers/RealtimeProvider.js";
import { TargetIcon, UserIcon, LightningIcon, GlobeIcon, SparkleIcon } from "../components/icons.js";
import { PromotionObjectiveCard, type PromotionObjectiveValues } from "../components/PromotionObjectiveCard.js";
import type {
  AudiencePersonaCard,
  Campaign,
  CampaignGenerationCitations,
  CampaignGenerationJobStatus,
  CampaignGenerationPipelineStatus,
  CampaignStrategyOption,
  CompetitorAdsData,
  DecisionContext,
  RankedRecommendation,
  ResearchContextLite,
  StrategySimulationResult,
} from "../api/client.js";
import { formatMoneyMinor } from "../constants/money.js";
import { useCurrency } from "../providers/CurrencyProvider.js";

const AVATAR_EMOJIS = ["🤖", "👨", "👩", "👩‍🦰", "🧑", "👩🏾"];
const POLL_INTERVAL_MS = 1500;

// Default budget for the generate call now that the pre-search budget slider was removed.
const DEFAULT_BUDGET_CENTS = 2000;

/**
 * Mirrors the pipeline's real phases (modules/orchestrator/campaignGenerationPipeline.ts) —
 * research -> decision + agents (concurrent) -> strategy assembly.
 *
 * This page always runs the pipeline with `deferBuild`, so the last phase stops at the STRATEGY:
 * no ad copy is committed to a campaign, no ad sets, no creative images. The label used to promise
 * "publication-ready ad creative & campaign structure" here, which was true before the build was
 * deferred and is now a phase that ticks green having created no ads at all. Keep these honest —
 * this list is the only account the user gets of a run that can take several minutes.
 *
 * Labels are deliberately short: each one already has a rotating subline underneath it, and two
 * full sentences per row is twice the reading for the same information.
 */
const PHASE_ORDER: { key: CampaignGenerationPipelineStatus; label: string; icon: typeof TargetIcon }[] = [
  { key: "researching", label: "Researching the product, audience and market", icon: GlobeIcon },
  { key: "aggregating", label: "Cross-checking every source and scoring confidence", icon: TargetIcon },
  { key: "running_agents", label: "Mining Meta interests and simulating strategies", icon: LightningIcon },
  { key: "building_campaign", label: "Assembling your strategy and ad angles", icon: SparkleIcon },
];

function phaseIndex(status: CampaignGenerationPipelineStatus): number {
  if (status === "completed") return PHASE_ORDER.length;
  if (status === "pending" || status === "failed") return -1;
  return PHASE_ORDER.findIndex((p) => p.key === status);
}

// Truthful, generic descriptions of what each phase is actually doing — rotates every few
// seconds so the loading state doesn't sit static for minutes at a time on slower runs.
const PHASE_SUBLINES: Record<CampaignGenerationPipelineStatus, string[]> = {
  pending: [],
  researching: [
    "Analyzing product positioning, features, pricing and use cases…",
    "Analyzing target audience profile and buyer personas…",
    "Analyzing competitors and calculating daily budget recommendations…",
    "Analyzing global market trends and regional growth patterns for target location recommendations…",
    "Comparing advertising platform performance to recommend optimal channel mix…",
    "Mining Meta Ads audience interest keywords from multiple dimensions…",
    "Crawling landing pages and extracting verified facts…",
    "Reading customer reviews and social signals…",
  ],
  aggregating: [
    "Validating product-related and competitor interest keywords in Meta Ads audience database…",
    "Validating user occupation and industry interest keywords…",
    "Validating professional interest and content consumption keywords…",
    "Validating extended competitor and business function keywords…",
    "Merging research sources into one confidence-scored context…",
  ],
  running_agents: [
    "Based on product analysis, mining Meta Ads audience interest keywords from multiple perspectives…",
    "Scoring and ranking 5 candidate recommendations head-to-head…",
    "Simulating 3 campaign strategies with real market data…",
    "Calculating genuine budget recommendation based on CPC benchmarks and competition…",
    "Building 6 audience personas with interest targeting…",
    "Analyzing opportunities, risks, and competitive gaps…",
  ],
  // Under deferBuild this phase assembles a Strategy — it does NOT write ads, ad sets or creative
  // images. Those happen in finishCampaignGenerationBuild, after the objective card.
  building_campaign: [
    "Bringing the ad angles, keywords and personas together…",
    "Applying the compliance and quality review…",
    "Scoring the candidate strategies against each other…",
    "Preparing your objective, budget and audience options…",
  ],
  completed: [],
  failed: [],
};

function phaseSubline(key: CampaignGenerationPipelineStatus): string {
  const lines = PHASE_SUBLINES[key];
  if (!lines || lines.length === 0) return "";
  return lines[Math.floor(Date.now() / 2500) % lines.length];
}

// Human-readable labels for the real step names GET /campaigns/generate/:id/progress
// returns (research provider names, then agent names, then phase-boundary markers) — falls
// back to the raw name for anything added on the backend before this map is updated, so a
// new provider/agent shows up as slightly-less-polished text instead of nothing.
const STEP_LABELS: Record<string, string> = {
  website: "Analyzing product positioning, features and use cases",
  company: "Researching company background and brand identity",
  market: "Analyzing global market trends and regional growth patterns",
  technology: "Detecting tech stack and integration opportunities",
  competitor: "Analyzing competitors and calculating daily budget benchmarks",
  seo: "Mining SEO keywords and search intent data",
  audience: "Analyzing target audience profile and behavior patterns",
  news: "Checking recent industry news and market signals",
  "social-media": "Analyzing social media engagement and brand sentiment",
  reviews: "Reading customer reviews for messaging insights",
  funding: "Checking funding signals and growth trajectory",
  "hiring-signals": "Analyzing hiring patterns for market timing",
  "content-marketing": "Evaluating content strategy and thought leadership",
  "backlink-authority": "Checking domain authority and competitive standing",
  "app-store": "Checking app store presence and ratings",
  "video-presence": "Analyzing video content and ad creative potential",
  "local-presence": "Checking local market presence and geo-targeting opportunities",
  partnerships: "Mapping partnership ecosystem and co-marketing opportunities",
  "legal-regulatory": "Checking legal & regulatory compliance for ad content",
  search: "Searching the web for real-time market intelligence",
  product: "Deep-crawling product pages, pricing tiers and feature comparisons",
  navigation: "Mapping site structure for landing page recommendations",
  "search-ranking": "Checking real search rankings vs. competitors",
  "ad-library": "Analyzing competitor ad libraries across Meta & Google",
  autocomplete: "Mining search autocomplete for audience intent signals",
  "serp-features": "Analyzing SERP features and ad opportunity gaps",
  reddit: "Mining community discussions for pain points and objections",
  aggregating: "Fusing research sources into confidence-scored context",
  "product-agent": "Analyzing product positioning and unique selling propositions",
  "audience-agent": "Mining Meta Ads audience interest keywords from multiple dimensions",
  "competitor-agent": "Mapping competitive gaps and differentiation strategy",
  "market-agent": "Comparing advertising platform performance for optimal channel recommendation",
  "keyword-agent": "Validating interest keywords in Meta Ads audience database",
  "creative-agent": "Generating publication-ready ad headlines and body copy",
  "budget-agent": "Calculating genuine budget recommendation based on CPC data and competition",
  "persona-agent": "Building 6 detailed audience personas with interest targeting",
  "campaign-agent": "Synthesizing full campaign strategy with platform-specific structure",
  "landing-page-agent": "Analyzing landing page conversion potential and recommendations",
  "pricing-offer-agent": "Analyzing pricing strategy and offer positioning for ads",
  "localization-agent": "Planning multi-market localization and geo-targeting",
  "seo-content-agent": "Planning SEO content funnel for organic growth alongside paid",
  "seasonality-timing-agent": "Analyzing seasonality patterns for optimal launch timing",
  "channel-placement-agent": "Recommending ad placements across Feed, Stories, Reels, Search",
  "funnel-retargeting-agent": "Planning retargeting funnel stages and audience segments",
  "objection-handling-agent": "Preparing objection-handling copy for ad variations",
  "forecasting-kpi-agent": "Forecasting KPIs: expected ROAS, CPA, reach and conversions",
  "critic-agent": "Quality review — validating strategy coherence and ad effectiveness",
  "compliance-agent": "Compliance review — checking Meta & Google ad policies",
  // Emitted at the end of the run whether or not a campaign was built — under deferBuild there is
  // no campaign yet, so this marker cannot claim one.
  "campaign-built": "Finalizing the strategy and recommendations",
};

function stepLabel(step: string): string {
  return STEP_LABELS[step] ?? step;
}

function formatRelativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days <= 0) {
    const hours = Math.floor(ms / (60 * 60 * 1000));
    return hours <= 0 ? "just now" : `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** "Researched N days ago" — surfaces `researchedAt`/`researchIsStale`, computed server-side
 * (router.ts, reusing research/knowledge/freshness.ts) against a 14-day horizon. Past that
 * horizon, offers a one-click re-run rather than leaving the user to guess whether a 3-week-old
 * campaign still reflects the business's current market/competitor/pricing landscape. */
function FreshnessBadge({ job, onRefresh, refreshing }: { job: CampaignGenerationJobStatus; onRefresh: () => void; refreshing: boolean }) {
  if (!job.researchedAt) return null;
  return (
    <div className={`freshness-badge${job.researchIsStale ? " stale" : ""}`}>
      <span>Researched {formatRelativeAge(job.researchedAt)}</span>
      {job.researchIsStale && (
        <button type="button" className="freshness-refresh-btn" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "May be outdated — refresh"}
        </button>
      )}
    </div>
  );
}

function formatCents(cents: number, currency: string): string {
  return formatMoneyMinor(cents, currency, { decimals: 0 });
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function AssistantTag({ time }: { time: string }) {
  const stamp = formatTimestamp(time);
  return (
    <div className="decision-assistant-tag">
      <span className="copilot-avatar">🤖</span>
      <span className="decision-assistant-name">CRM Ads AI</span>
      {stamp && <span className="decision-assistant-time">{stamp}</span>}
    </div>
  );
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function scoreTier(score: number): "score-high" | "score-mid" | "score-low" {
  if (score >= 75) return "score-high";
  if (score >= 50) return "score-mid";
  return "score-low";
}

function RecommendationRow({ rec, rank }: { rec: RankedRecommendation; rank: number }) {
  const evidence = rec.evidence ?? [];
  const score = Math.round(rec.finalScore);
  return (
    <div className="rec-item">
      <div className="rec-item-head">
        <span className="rec-item-rank">#{rank}</span>
        <span className="category-tag">{rec.category}</span>
        <span className="rec-item-title">{rec.title}</span>
        <span className={`score-badge ${scoreTier(score)}`}>{score}/100</span>
      </div>
      <p className="rec-item-reason">{rec.reason}</p>
      <p className="rec-item-outcome"><strong>Expected outcome:</strong> {rec.expectedOutcome}</p>
      {evidence.length > 0 && (
        <details>
          <summary>Why ({evidence.length} source{evidence.length === 1 ? "" : "s"})</summary>
          <ul className="rec-item-evidence">
            {evidence.map((e) => <li key={e}>{e}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Direction matters for the color read: higher reach/ROI/budget-efficiency is good (green),
 * higher competition/risk is bad (amber) — a plain "bigger bar = better" would mislead on
 * the latter two. */
const METRIC_ROWS: { key: keyof StrategySimulationResult; label: string; goodHigh: boolean }[] = [
  { key: "reach", label: "Reach", goodHigh: true },
  { key: "competition", label: "Competition", goodHigh: false },
  { key: "expectedRoi", label: "Exp. ROI", goodHigh: true },
  { key: "risk", label: "Risk", goodHigh: false },
  { key: "budgetEfficiency", label: "Budget eff.", goodHigh: true },
];

function truncateText(s: string, max: number) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max).trimEnd() + "…";
}

function StrategyCard({ strategy, simulation, isWinner, onSelect, selecting, disabled }: {
  strategy: CampaignStrategyOption;
  simulation?: StrategySimulationResult;
  isWinner: boolean;
  onSelect?: () => void;
  selecting?: boolean;
  disabled?: boolean;
}) {
  const { currency } = useCurrency();
  const platforms = strategy.platforms ?? [];
  return (
    <div className={`strategy-card-v2 ${isWinner ? "winner" : ""}`}>
      <div className="strategy-card-v2-head">
        <span className="strategy-card-v2-label">{strategy.label}</span>
        {isWinner && <span className="decision-winner-badge">★ Recommended</span>}
      </div>

      {simulation && (
        <div className="metric-bars">
          {METRIC_ROWS.map(({ key, label, goodHigh }) => {
            const value = Math.max(0, Math.min(100, Math.round(simulation[key] as number)));
            const isGood = goodHigh ? value >= 60 : value <= 40;
            return (
              <div className="metric-bar-row" key={key}>
                <span>{label}</span>
                <span className="metric-bar-track">
                  <span
                    className="metric-bar-fill"
                    style={{ width: `${value}%`, background: isGood ? "var(--accent-2)" : value > 66 && !goodHigh ? "var(--danger)" : undefined }}
                  />
                </span>
                <span className="metric-bar-value">{value}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="strategy-card-v2-field"><strong>Target Audience</strong>{truncateText(strategy.targetAudience, 80)}</div>
      <div className="strategy-card-v2-field"><strong>Platforms &amp; Objective</strong>{platforms.join(", ") || "—"} · {strategy.objective}</div>
      <div className="strategy-card-v2-field"><strong>Budget</strong>{formatCents(strategy.budgetDailyCents, currency)}/day · KPI: {truncateText(strategy.expectedKpi, 60)}</div>
      <div className="strategy-card-v2-field"><strong>Creative Direction</strong>{truncateText(strategy.creativeDirection, 100)}</div>
      <div className="strategy-card-v2-field"><strong>Messaging</strong>{truncateText(strategy.messaging, 80)}</div>
      {onSelect && (
        <button
          type="button"
          className={`btn btn-sm strategy-card-v2-select ${isWinner ? "btn-primary" : "btn-secondary"}`}
          onClick={onSelect}
          disabled={selecting || disabled}
        >
          {selecting ? "Building campaign…" : "Use this campaign"}
        </button>
      )}
    </div>
  );
}

const PERSONA_AVATAR_COLORS = [
  { bg: "#e8f0fe", color: "#4285f4" },
  { bg: "#e6f4ea", color: "#34a853" },
  { bg: "#fef7e0", color: "#f9ab00" },
  { bg: "#fce8e6", color: "#ea4335" },
  { bg: "#f3e8fd", color: "#1c9ce0" },
];

function PersonaCarousel({ personas }: { personas: AudiencePersonaCard[] }) {
  return (
    <div className="persona-grid-wrap">
      <div className="persona-grid">
        {personas.map((p, i) => {
          const avatar = PERSONA_AVATAR_COLORS[i % PERSONA_AVATAR_COLORS.length];
          const desc = p.description.length > 90 ? p.description.slice(0, 90).trimEnd() + "…" : p.description;
          const interests = (p.interests ?? []).slice(0, 3);
          return (
            <div key={p.name} className="persona-card-v2" style={{ borderTopColor: avatar.color }}>
              <div className="persona-card-v2-top">
                <div className="persona-card-v2-avatar" style={{ background: avatar.bg, color: avatar.color }}>
                  <UserIcon />
                </div>
                <div className="persona-card-v2-info">
                  <div className="persona-card-v2-name">{p.name}</div>
                  {(p.ageRange || p.genderSplit) && (
                    <div className="persona-card-v2-meta">
                      {p.ageRange && <span>{p.ageRange}</span>}
                      {p.genderSplit && <span>{p.genderSplit}</span>}
                    </div>
                  )}
                </div>
              </div>
              <p className="persona-card-v2-desc">{desc}</p>
              {interests.length > 0 && (
                <div className="persona-card-v2-tags">
                  {interests.map((tag) => (
                    <span key={tag} className="persona-card-v2-tag" style={{ color: avatar.color, background: avatar.bg }}>{tag.length > 25 ? tag.slice(0, 25) + "…" : tag}</span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * DecisionContext is persisted as a plain JSON blob (CampaignGenerationJob.decisionContext) —
 * a job completed by an older version of decision-engine.ts (e.g. before audiencePersonas
 * existed) has no way to retroactively gain new fields, so every array/record field here is
 * defaulted rather than trusted, even though the TS type says they're required. Real bug this
 * fixes: an old completed job's missing `audiencePersonas` crashed the whole page with
 * "Cannot read properties of undefined (reading 'length')".
 */
function normalizeDecision(decision: DecisionContext) {
  return {
    ...decision,
    recommendations: decision.recommendations ?? [],
    strategies: decision.strategies ?? [],
    simulations: decision.simulations ?? [],
    topOpportunities: decision.topOpportunities ?? [],
    topRisks: decision.topRisks ?? [],
    evidence: decision.evidence ?? [],
    audiencePersonas: decision.audiencePersonas ?? [],
    recommendedChannels: decision.recommendedChannels ?? [],
    recommendedBudgetAllocation: decision.recommendedBudgetAllocation ?? {},
    pricingTiers: decision.pricingTiers ?? [],
    notableCustomers: decision.notableCustomers ?? [],
    quantifiedProofPoints: decision.quantifiedProofPoints ?? [],
    regionalMarketDepth: decision.regionalMarketDepth ?? null,
    recommendedDailyBudgetCents: decision.recommendedDailyBudgetCents ?? 0,
    budgetReasoning: decision.budgetReasoning ?? [],
  };
}

const BUDGET_COLORS = ["var(--accent)", "var(--accent-2)", "#f9ab00", "#ea4335", "var(--accent-light)"];

/** Keyless live thumbnail of a public URL (WordPress mShots) — a no-API-key fallback used when the
 * backend Playwright/Firecrawl screenshot capture is unavailable, so the site preview effectively
 * never goes blank. */
function siteThumbnailUrl(pageUrl: string): string {
  return `https://s.wordpress.com/mshots/v1/${encodeURIComponent(pageUrl)}?w=1200`;
}

/**
 * Site preview that never renders an empty box: prefer the backend capture (above-the-fold JPEG
 * from the Playwright scraper-service or Firecrawl); if it's absent, fall back to a keyless live
 * thumbnail of the URL; if even that fails to load, show a labeled placeholder.
 */
function HeroScreenshot({ url, screenshot }: { url: string; screenshot?: string }) {
  const [stage, setStage] = useState<"primary" | "thumbnail" | "placeholder">(
    screenshot ? "primary" : url ? "thumbnail" : "placeholder"
  );

  if (stage === "placeholder") {
    return (
      <div className="decision-hero-shot decision-hero-shot--placeholder">
        <GlobeIcon />
        <span>Site preview unavailable</span>
      </div>
    );
  }

  const src = stage === "primary" && screenshot ? screenshot : siteThumbnailUrl(url);
  return (
    <div className="decision-hero-shot">
      <img
        src={src}
        alt={`Screenshot of ${url}`}
        onError={() => setStage((s) => (s === "primary" && url ? "thumbnail" : "placeholder"))}
      />
    </div>
  );
}

function CollapsibleSection({ title, icon, defaultOpen = false, children }: { title: string; icon: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`decision-section dc-collapsible${open ? " dc-open" : ""}`}>
      <button type="button" className="dc-toggle" onClick={() => setOpen(!open)}>
        <span className="decision-section-title"><span className="icon-badge">{icon}</span>{title}</span>
        <span className="dc-chevron">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="dc-body">{children}</div>}
    </div>
  );
}

function DecisionContextView({ decision: raw, url, jobId, onSelectStrategy, selectingStrategy }: {
  decision: DecisionContext;
  url: string;
  jobId?: string;
  onSelectStrategy?: (strategyRef: string) => void;
  selectingStrategy?: string | null;
}) {
  const { currency } = useCurrency();
  const decision = normalizeDecision(raw);
  const simByStrategy = new Map(decision.simulations.map((s) => [s.strategyId, s]));
  const sortedStrategies = [...decision.strategies].sort(
    (a, b) => (simByStrategy.get(a.id)?.rank ?? 99) - (simByStrategy.get(b.id)?.rank ?? 99)
  );
  const topRecommendations = decision.recommendations.slice(0, 5);
  const budgetEntries = Object.entries(decision.recommendedBudgetAllocation);
  const winnerId = sortedStrategies[0]?.id;
  const confidencePct = Math.round(decision.confidence * 100);
  const region = decision.regionalMarketDepth;

  return (
    <div className="decision-results-shell">
    <div className="decision-results">
      <AssistantTag time={decision.generatedAt} />

      {/* Hero — always visible */}
      <div className="decision-hero">
        <HeroScreenshot url={url} screenshot={decision.websiteScreenshot} />
        <div className="decision-hero-body">
          <p className="decision-hero-eyebrow">{url || "Your page"}</p>
          <p className="decision-hero-summary">{decision.businessSummary}</p>

          {decision.quantifiedProofPoints.length > 0 && (
            <div className="proof-chip-row">
              {decision.quantifiedProofPoints.slice(0, 3).map((p) => <span key={p} className="proof-chip">{p}</span>)}
            </div>
          )}

          <div className="decision-hero-meta">
            <div className="decision-confidence">
              <div className="decision-confidence-ring" style={{ "--pct": confidencePct } as CSSProperties} />
              <div>
                <div className="decision-confidence-label">Confidence</div>
                <div className="decision-confidence-value">{confidencePct}%</div>
              </div>
            </div>
            {sortedStrategies[0] && <span className="decision-winner-badge">★ {sortedStrategies[0].label} wins</span>}
            {decision.recommendedDailyBudgetCents > 0 && (
              <span className="decision-budget-badge">{formatCents(decision.recommendedDailyBudgetCents, currency)}/day</span>
            )}
          </div>
        </div>
      </div>

      {/* Quick summary bar — channels + budget allocation */}
      <div className="dc-summary-bar">
        {decision.recommendedChannels.length > 0 && (
          <div className="dc-summary-item">
            <span className="dc-summary-label">Channels</span>
            <span className="channel-chip-row">
              {decision.recommendedChannels.map((c) => <span key={c} className="channel-chip">{c}</span>)}
            </span>
          </div>
        )}
        {budgetEntries.length > 0 && (
          <div className="dc-summary-item dc-summary-grow">
            <span className="dc-summary-label">Budget Split</span>
            <span className="budget-bar">
              {budgetEntries.map(([k, v], i) => (
                <span key={k} className="budget-bar-segment" style={{ width: `${v * 100}%`, background: BUDGET_COLORS[i % BUDGET_COLORS.length] }} title={`${k} ${pct(v)}`} />
              ))}
            </span>
            <span className="budget-bar-legend">
              {budgetEntries.map(([k, v], i) => (
                <span key={k}><span className="budget-bar-legend-dot" style={{ background: BUDGET_COLORS[i % BUDGET_COLORS.length] }} />{k} {pct(v)}</span>
              ))}
            </span>
          </div>
        )}
      </div>

      {/* Collapsible sections */}
      {decision.audiencePersonas.length > 0 && (
        <CollapsibleSection title={`Audience Personas (${decision.audiencePersonas.length})`} icon={<UserIcon />} defaultOpen>
          <PersonaCarousel personas={decision.audiencePersonas} />
        </CollapsibleSection>
      )}

      {(decision.topOpportunities.length > 0 || decision.topRisks.length > 0) && (
        <CollapsibleSection title="Opportunities & Risks" icon={<LightningIcon />}>
          <div className="callout-grid">
            {decision.topOpportunities.length > 0 && (
              <div className="callout-card good">
                <p className="callout-card-title">Opportunities</p>
                <ul>{decision.topOpportunities.slice(0, 4).map((o) => <li key={o}>{o}</li>)}</ul>
              </div>
            )}
            {decision.topRisks.length > 0 && (
              <div className="callout-card risk">
                <p className="callout-card-title">Risks</p>
                <ul>{decision.topRisks.slice(0, 4).map((r) => <li key={r}>{r}</li>)}</ul>
              </div>
            )}
          </div>
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Recommended Direction" icon={<GlobeIcon />}>
        {region && (
          <div className="regional-depth-row">
            <span className="regional-depth-stat"><strong>Region</strong>{region.region}</span>
            {region.marketSize && <span className="regional-depth-stat"><strong>Market Size</strong>{region.marketSize}</span>}
            {region.growthRate && <span className="regional-depth-stat"><strong>Growth Rate</strong>{region.growthRate}</span>}
          </div>
        )}
        <dl className="field-grid">
          <div><dt>Positioning</dt><dd>{decision.recommendedPositioning}</dd></div>
          <div><dt>Audience Priority</dt><dd>{decision.recommendedAudiencePriority}</dd></div>
          <div className="field-full"><dt>Creative Direction</dt><dd>{decision.recommendedCreativeDirection}</dd></div>
          <div><dt>Offer</dt><dd>{decision.recommendedOffer}</dd></div>
          <div><dt>Messaging</dt><dd>{decision.recommendedMessaging}</dd></div>
        </dl>
      </CollapsibleSection>

      {topRecommendations.length > 0 && (
        <CollapsibleSection title={`Top Recommendations (${topRecommendations.length})`} icon={<SparkleIcon />}>
          <div className="rec-list">
            {topRecommendations.map((r, i) => <RecommendationRow key={r.id} rec={r} rank={i + 1} />)}
          </div>
        </CollapsibleSection>
      )}

      {sortedStrategies.length > 0 && (
        <CollapsibleSection title={`${sortedStrategies.length} Complete Campaign Suggestions`} icon={<TargetIcon />} defaultOpen>
          {onSelectStrategy && (
            <p className="strategy-grid-hint muted-text">
              Each suggestion is a complete campaign with Meta &amp; Google ads ready to launch. Pick one to open it in the builder.
            </p>
          )}
          <div className="strategy-grid">
            {sortedStrategies.map((s) => (
              <StrategyCard
                key={s.id}
                strategy={s}
                simulation={simByStrategy.get(s.id)}
                isWinner={s.id === winnerId}
                onSelect={onSelectStrategy ? () => onSelectStrategy(s.id) : undefined}
                selecting={selectingStrategy === s.id}
                disabled={!!selectingStrategy && selectingStrategy !== s.id}
              />
            ))}
          </div>
        </CollapsibleSection>
      )}

      {decision.evidence.length > 0 && (
        <details className="decision-evidence-toggle">
          <summary>Show all supporting evidence ({decision.evidence.length})</summary>
          <ul>{decision.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
        </details>
      )}
    </div>
    </div>
  );
}

const FACTS_PREVIEW_COUNT = 6;

/** `new URL()` throws on a bare hostname with no scheme (e.g. legacy CrawlJob/CrawlPage
 * rows persisted before WebsiteProvider started normalizing input.url) — parse defensively
 * so one bad row can't crash the whole facts panel. */
function safeParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Loose format check for the "which page would you like to promote" input — accepts a
 * bare domain (no scheme required, matching what people actually type: "polluxa.com" not
 * "https://polluxa.com") but rejects plain text that was never a URL at all. Mirrors
 * businessService.ts's domainFromWebsite() prepend-scheme-then-parse logic on the backend,
 * and requires a dot in the hostname so a single bare word doesn't parse as "valid" (`new
 * URL("hello")` resolves to a relative-looking URL and won't throw on its own). */
function looksLikePageUrl(value: string): boolean {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = safeParseUrl(withScheme);
  return !!parsed && parsed.hostname.includes(".");
}

/** Streams the RESEARCHED OUTPUT (company summary, market, audience, competitors) into the UI
 * DURING the run — research completes roughly halfway through, well before the decision engine
 * produces the final strategy, so this shows what we've learned about the business while the rest
 * still runs. Fetches once `researchJobId` exists, re-polls while `streaming`, and is meant to be
 * hidden by the caller once the full DecisionContextView renders at completion (avoids duplication).
 * Renders nothing until a research context with a company summary is available. */
function ResearchOutputPreview({ researchJobId, streaming }: { researchJobId: string; streaming?: boolean }) {
  const [ctx, setCtx] = useState<ResearchContextLite | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.getResearchJob(researchJobId).then((r) => { if (!cancelled) setCtx(r.context); }).catch(() => {});
    load();
    if (!streaming) return () => { cancelled = true; };
    const timer = window.setInterval(load, 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [researchJobId, streaming]);

  const summary = ctx?.company?.summary?.trim();
  if (!summary) return null;

  const competitors = (ctx?.competitors?.competitors ?? []).map((c) => c.name).filter(Boolean).slice(0, 5);
  const painPoints = (ctx?.audience?.painPoints ?? []).filter(Boolean).slice(0, 3);

  return (
    <div className="research-output-preview">
      <p className="decision-section-title">
        <span className="icon-badge" aria-hidden="true">🔎</span>
        What we've learned so far{streaming ? " — still analyzing…" : ""}
      </p>
      <p className="research-output-summary">{summary}</p>
      <div className="research-output-grid">
        {ctx?.audience?.primaryAudience && (
          <div className="research-output-item"><span className="research-output-key">Primary audience</span><span>{ctx.audience.primaryAudience}</span></div>
        )}
        {painPoints.length > 0 && (
          <div className="research-output-item"><span className="research-output-key">Pain points</span><span>{painPoints.join(" · ")}</span></div>
        )}
        {ctx?.market?.recommendedRegion && (
          <div className="research-output-item"><span className="research-output-key">Region</span><span>{ctx.market.recommendedRegion}</span></div>
        )}
        {competitors.length > 0 && (
          <div className="research-output-item"><span className="research-output-key">Competitors</span><span>{competitors.join(" · ")}</span></div>
        )}
      </div>
    </div>
  );
}

/** Real competitor ad creative (Meta Ad Library API + Google Ads Transparency Center) — the one
 * new field that doesn't fit the generic evidence-link display, since each entry is a
 * headline/body/preview object rather than a narrative string. */
function CompetitorAdsCard({ competitorAds }: { competitorAds: CompetitorAdsData }) {
  if (competitorAds.ads.length === 0) return null;
  return (
    <div className="decision-section competitor-ads-card">
      <p className="decision-section-title"><span className="icon-badge"><TargetIcon /></span>Competitor Ads — {competitorAds.ads.length} found</p>
      <ul className="competitor-ads-list">
        {competitorAds.ads.slice(0, 10).map((ad, i) => (
          <li key={`${ad.sourceUrl}-${i}`} className="competitor-ad-row">
            <span className={`competitor-ad-platform-badge competitor-ad-platform-${ad.platform}`}>{ad.platform === "meta" ? "Meta" : "Google"}</span>
            <span className="competitor-ad-advertiser">{ad.advertiserName}</span>
            {ad.headline && <span className="competitor-ad-headline">{ad.headline}</span>}
            {ad.bodyText && <span className="competitor-ad-body">{ad.bodyText}</span>}
            <a href={ad.sourceUrl} target="_blank" rel="noreferrer" className="competitor-ad-link">View ad</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Fetches real citation data (same one-shot pattern as VerifiedFactsSection above) and
 * renders the Competitor Ads card. A citations-fetch failure just means the card doesn't
 * render, never a broken page. */
function CompetitorAdsSection({ jobId }: { jobId: string }) {
  const [citations, setCitations] = useState<CampaignGenerationCitations | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getCampaignGenerationCitations(jobId).then((d) => { if (!cancelled) setCitations(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [jobId]);

  return citations?.competitorAds ? <CompetitorAdsCard competitorAds={citations.competitorAds} /> : null;
}

export default function NewCampaign() {
  const { currency } = useCurrency();
  const { workspaceId, businessId } = useAuth();
  const navigate = useNavigate();
  const { subscribe } = useRealtimeContext();
  const wsId = currentWorkspaceId(workspaceId);
  const activeJobKey = `polluxa_active_campaign_generation_${wsId}`;
  const activeJobUrlKey = `${activeJobKey}_url`;
  /**
   * The last website URL typed into this form, kept SEPARATELY from the active-job pointer.
   *
   * activeJobUrlKey is deleted the moment a job reaches a terminal state, which is correct for the
   * job itself (a finished run must not be resurrected — see the resume effect below) but threw away
   * the URL as collateral. The result: generate a campaign, go into the builder, come back, and the
   * form is empty again, so the same address has to be retyped every single time.
   *
   * Remembering the input is not the same as restoring a stale result: this only pre-fills a text
   * box the user is free to change, and never revives a job, its research, or its output.
   */
  const lastUrlKey = `polluxa_last_campaign_url_${wsId}`;

  const [pageUrl, setPageUrl] = useState("");
  // Latest Promotion Objective selections, mirrored out of the card so pressing Enter in the URL
  // field submits exactly what is on screen rather than the card's untouched defaults.
  const [promoValues, setPromoValues] = useState<PromotionObjectiveValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState<CampaignGenerationJobStatus | null>(null);
  const [progressSteps, setProgressSteps] = useState<string[]>([]);
  const [progressTotal, setProgressTotal] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef<number | null>(null);

  // ── adsgo.ai-style setup controls ──
  // The pre-search setup UI (objective chips / platforms / budget slider / ballpark projection) was
  // removed — these still parameterize the generate call (handleStart) with sensible defaults; the
  // Deep Research pipeline derives the real objective/budget from the crawled site regardless.
  const [objective] = useState<string>("OUTCOME_TRAFFIC");
  const [networks] = useState<("meta" | "google")[]>(["meta", "google"]);
  const [dailyBudgetCents] = useState<number>(DEFAULT_BUDGET_CENTS);

  // ── publish / go-live / auto-optimize (post-generation) ──
  const [publishedCampaign, setPublishedCampaign] = useState<Campaign | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [goingLive, setGoingLive] = useState(false);
  const [autoOptimize, setAutoOptimize] = useState(true);
  // Which candidate strategy (by id) is currently being materialized into an editable campaign,
  // so the picked card shows "Building…" and the others disable while the build is in flight.
  const [selectingStrategy, setSelectingStrategy] = useState<string | null>(null);

  // Resume ONLY a still-running generation. Generation runs server-side (BullMQ worker) regardless
  // of whether this component is mounted, so persisting the job id lets an IN-PROGRESS run resume
  // when you navigate back. But a COMPLETED/FAILED job must NOT be auto-restored: doing so
  // resurrected a days-old finished result (the "stale 62% / Strategy C" polluxa view) every time
  // the page was opened, because the status fetch succeeds for a finished job and it never
  // self-cleared. Now a terminal job clears the pointer and leaves a fresh form instead.
  useEffect(() => {
    // Pre-fill the address box from the last one used, whatever happened to the job behind it.
    // Done before the resume check so it applies even when there is no saved job at all — which is
    // the common case (a finished run clears its pointer) and exactly when retyping was required.
    const lastUrl = localStorage.getItem(lastUrlKey);
    if (lastUrl) setPageUrl(lastUrl);

    const savedId = localStorage.getItem(activeJobKey);
    if (!savedId) return;
    const clearPointer = () => {
      localStorage.removeItem(activeJobKey);
      localStorage.removeItem(activeJobUrlKey);
    };
    api
      .getCampaignGenerationStatus(savedId)
      .then((restored) => {
        // Only in-flight statuses resume; a finished/failed job is stale — drop it and start clean.
        const inProgress = restored.status !== "completed" && restored.status !== "failed";
        if (inProgress) {
          const savedUrl = localStorage.getItem(activeJobUrlKey);
          if (savedUrl) setPageUrl(savedUrl);
          setJob(restored);
        } else {
          clearPointer();
        }
      })
      .catch(clearPointer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Verified facts are persisted in Phase 1 (crawl fact-extraction), long before the run finishes,
  // so reveal them as soon as we're PAST research — they stream in progressively via the status
  // poll instead of staying hidden until "completed". The facts endpoint returns [] until rows
  // exist, so showing the section early just renders empty until the first facts land, never errors.
  const factsVisible =
    job?.status === "completed" ||
    job?.status === "building_campaign" ||
    job?.status === "running_agents" ||
    job?.status === "aggregating";

  // Real-time WebSocket progress updates (instant, replaces polling as primary source)
  useEffect(() => {
    if (!job || job.status === "completed" || job.status === "failed") return;
    const unsub = subscribe(`campaign.progress:${job.id}`, (_ch, payload: any) => {
      if (payload?.step) {
        setProgressSteps((prev) => prev.includes(payload.step) ? prev : [...prev, payload.step]);
      }
      if (payload?.progress) setProgressTotal((prev) => Math.max(prev ?? 0, Number(payload.progress) || 0));
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status, subscribe]);

  // Polling fallback: still needed for status changes (completed/failed) and as a safety net
  useEffect(() => {
    if (!job || job.status === "completed" || job.status === "failed") {
      if (pollRef.current) window.clearInterval(pollRef.current);
      return;
    }
    pollRef.current = window.setInterval(async () => {
      try {
        const updated = await api.getCampaignGenerationStatus(job.id);
        setJob(updated);
      } catch {
        // transient poll failure — the next tick will retry
      }
      try {
        const progress = await api.getCampaignGenerationProgress(job.id);
        setProgressSteps(progress.completedSteps);
        setProgressTotal(progress.total);
      } catch {
        // no live progress available (older job, Redis miss) — the static fallback messaging still shows
      }
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  // Elapsed clock. A run takes minutes, and the only previous signal that it was still alive was a
  // subline rotating every 2.5s. Driven by its own interval rather than derived at render: renders
  // happen on poll ticks, so a few failed polls would freeze the clock, and a stopped clock reads
  // as a hung job.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!job || job.status === "completed" || job.status === "failed") return;
    const tick = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [job?.id, job?.status]);

  /**
   * Kick off DEEP RESEARCH only — no ads are written yet.
   *
   * `deferBuild` stops the pipeline once research, the agents and the strategy are done. The
   * Promotion Objective card then appears with real findings behind it, and the ads are written
   * afterwards from the selections the user makes (handleBuildCampaign).
   *
   * This ordering is the point: previously every ad existed before the user was asked anything, so
   * deselecting Google could only discard work already paid for.
   */
  async function handleStart() {
    const url = pageUrl.trim();
    if (!url) {
      setError("Please enter a page URL to continue.");
      return;
    }
    if (!looksLikePageUrl(url)) {
      setError("That doesn't look like a valid URL — try something like polluxa.com or https://polluxa.com.");
      return;
    }
    if (!businessId) {
      setError("No business selected yet — try again in a moment.");
      return;
    }
    setError(null);
    setStarting(true);
    try {
      const created = await api.generateCampaign({
        workspaceId: wsId,
        businessId,
        url,
        dailyBudgetCents,
        // Research now, decide later — the objective/platforms/locations come from the card once
        // this finishes, and the ads are built then.
        deferBuild: true,
      });
      setJob(created);
      setProgressSteps([]);
      setProgressTotal(null);
      localStorage.setItem(activeJobKey, created.id);
      localStorage.setItem(activeJobUrlKey, url);
      // Outlives the job pointer so the box is still pre-filled after the run finishes.
      localStorage.setItem(lastUrlKey, url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start research — check the URL and try again.");
    } finally {
      setStarting(false);
    }
  }

  /**
   * Write the ads, now that the user has said what they want.
   *
   * This is the second half of a deferBuild run: research/agents/strategy already completed, and
   * POST /campaigns/generate/:id/build turns the strategy into real variants using these
   * selections. Idempotent server-side, so a double-click cannot produce two campaigns.
   */
  async function handleBuildCampaign(values: PromotionObjectiveValues) {
    if (!job?.id) return;
    if (!values.platforms.length) {
      setError("Pick at least one ad platform to generate for.");
      return;
    }
    setError(null);
    setPublishing(true);
    try {
      const built = await api.buildGeneratedCampaign(job.id, {
        objective: values.metaObjective,
        dailyBudgetCents: values.dailyBudgetCents > 0 ? values.dailyBudgetCents : undefined,
        channels: values.platforms,
        countries: values.locations,
        conversionEvent: values.conversionEvent,
      });
      // Reflect the new campaignId locally so the page swaps to the post-build actions without
      // waiting for the next poll.
      setJob((prev) => (prev ? { ...prev, campaignId: built.campaignId } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't generate the campaign — try again.");
    } finally {
      setPublishing(false);
    }
  }

  // One-click publish: builds the real Meta/Google hierarchy (all PAUSED) via launchCampaign,
  // using the workspace's default ad-account connection — no builder round-trip. A 422 means a
  // needed platform isn't connected; surface it with a link to the connection settings.
  async function handlePublish(values?: PromotionObjectiveValues) {
    if (!job?.campaignId) return;
    setPublishing(true);
    setError(null);
    try {
      // Apply the Promotion Objective card's selections to the generated campaign before launch, so
      // the user's real-time choices (budget / conversion event / target locations) take effect —
      // best-effort: a patch failure shouldn't block publishing the campaign that was generated.
      if (values) {
        const patch: Parameters<typeof api.updateCampaign>[1] = {};
        if (values.dailyBudgetCents > 0) patch.dailyBudgetCents = values.dailyBudgetCents;
        if (values.conversionEvent) patch.conversionEvent = values.conversionEvent;
        if (values.locations.length) patch.locations = values.locations;
        if (Object.keys(patch).length) {
          await api.updateCampaign(job.campaignId, patch).catch(() => {});
        }
      }
      const launched = await api.launchCampaign(job.campaignId, wsId);
      setPublishedCampaign(launched);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Publish failed — try again.";
      if (/META_NOT_CONNECTED|Meta ad account/i.test(msg)) {
        setError("Connect your Meta ad account before publishing. Open Settings → Ad Platform Connection.");
      } else if (/GOOGLE_NOT_CONNECTED|Google Ads account/i.test(msg)) {
        setError("Connect your Google Ads account before publishing. Open Settings → Ad Platform Connection.");
      } else {
        setError(msg);
      }
    } finally {
      setPublishing(false);
    }
  }

  // "Generate Campaign" (the Promotion Objective card's CTA) — applies the card's real-time
  // selections (budget / conversion event / target locations) to the generated campaign, then
  // OPENS IT IN THE BUILDER so the user can review/fine-tune before publishing (they publish from
  // the builder). This is the "open the campaign builder" behavior the button is expected to have,
  // as opposed to handlePublish (which launches PAUSED directly).
  async function handleGenerateToBuilder(values?: PromotionObjectiveValues) {
    if (!job?.campaignId) return;
    setPublishing(true);
    setError(null);
    try {
      // One fetch, reused for the platform filter below and for the slug in the final URL.
      let campaign = await api.getCampaign(job.campaignId).catch(() => null);
      if (values) {
        const patch: Parameters<typeof api.updateCampaign>[1] = {};
        if (values.dailyBudgetCents > 0) patch.dailyBudgetCents = values.dailyBudgetCents;
        if (values.conversionEvent) patch.conversionEvent = values.conversionEvent;
        if (values.locations.length) patch.locations = values.locations;

        // ── Ad Platform picker ──
        // values.platforms was being collected and then thrown away: unticking Google changed
        // nothing, and the campaign still arrived in the builder with Google ads. The picker is
        // shown AFTER generation (isDone), so honouring it means dropping the variants for
        // deselected networks rather than preventing their creation.
        // Never applied if it would empty the campaign — an all-unticked selection reads as
        // "no filter", not "delete every ad".
        if (campaign && values.platforms.length) {
          const kept = campaign.variants.filter((v) => (values.platforms as string[]).includes(v.network));
          if (kept.length && kept.length !== campaign.variants.length) patch.variants = kept;
        }

        if (Object.keys(patch).length) {
          const updated = await api.updateCampaign(job.campaignId, patch).catch(() => null);
          if (updated) campaign = updated;
        }
      }
      navigate(campaign ? campaignPath(campaign, "/builder") : `/campaigns/${job.campaignId}/builder`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open the campaign builder — try again.");
      setPublishing(false);
    }
  }

  // "Go live" — flips every launched (PAUSED) variant to ACTIVE, sets the persistent auto-optimize
  // preference, then pulls metrics once immediately so CampaignDetail isn't empty for 15 minutes.
  async function handleGoLive() {
    const campaign = publishedCampaign;
    if (!campaign) return;
    setGoingLive(true);
    setError(null);
    try {
      const launchedVariants = campaign.variants.filter((v) => v.externalId && v.status !== "active");
      for (const v of launchedVariants) {
        try { await api.activateVariant(campaign.id, v.id); } catch { /* one variant failing shouldn't block the rest */ }
      }
      await api.setAutoOptimize(campaign.id, autoOptimize).catch(() => {});
      await api.ingestMetrics(campaign.id).catch(() => {}); // best-effort first metrics pull
      navigate(`/campaigns/${campaign.id}`);
    } finally {
      setGoingLive(false);
    }
  }

  // Picks one of the 3 candidate strategies and opens its complete campaign in the builder.
  // The winner reuses the campaign the pipeline already built; a non-winner is built on demand
  // from data already computed (POST .../select-strategy). Either way the user lands in the
  // builder with a full Meta + Google ad set for that strategy.
  async function handleSelectStrategy(strategyRef: string) {
    if (!job?.id || selectingStrategy) return;
    setSelectingStrategy(strategyRef);
    setError(null);
    try {
      const result = await api.selectCampaignStrategy(job.id, strategyRef);
      navigate(await campaignPathById(result.campaignId, api.getCampaign, "/builder"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't build that campaign — try another suggestion.");
      setSelectingStrategy(null);
    }
  }

  // Re-runs the exact same generation pipeline against the same URL/business — deliberately
  // "Refresh research" must force a genuinely fresh crawl, so it passes forceRefresh:true. Without
  // it, POST /campaigns/generate re-serves a recent completed job for the same (workspace,business,
  // url) — AND the pipeline reuses cached research within its TTL — so "refresh" would silently
  // return the same stale run (and, worse, a job whose campaign may since have been deleted, which
  // is exactly how the builder ended up on a "Campaign not found" id). forceRefresh bypasses both
  // the router short-circuit and the pipeline research cache, guaranteeing a real re-crawl.
  async function handleRefresh() {
    if (!job?.url || !businessId) return;
    setRefreshing(true);
    setError(null);
    try {
      // deferBuild must match handleStart: without it a refresh silently reverts to the old
      // behaviour — ads written before the user is asked anything, and no objective card at the
      // end because job.campaignId is already set.
      const created = await api.generateCampaign({
        workspaceId: wsId,
        businessId,
        url: job.url,
        dailyBudgetCents,
        forceRefresh: true,
        deferBuild: true,
      });
      setJob(created);
      setProgressSteps([]);
      setProgressTotal(null);
      localStorage.setItem(activeJobKey, created.id);
      localStorage.setItem(activeJobUrlKey, job.url);
      localStorage.setItem(lastUrlKey, job.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't refresh research — try again in a moment.");
    } finally {
      setRefreshing(false);
    }
  }

  function handleReset() {
    setJob(null);
    setError(null);
    setPageUrl("");
    setProgressSteps([]);
    setProgressTotal(null);
    setPublishedCampaign(null);
    localStorage.removeItem(activeJobKey);
    localStorage.removeItem(activeJobUrlKey);
  }

  const isActive = Boolean(job) && job!.status !== "completed" && job!.status !== "failed";
  const isDone = job?.status === "completed";
  const isFailed = job?.status === "failed";
  const currentPhaseIndex = job ? phaseIndex(job.status) : -1;

  // m:ss since the pipeline actually started (not since the row was created — a queued job can sit
  // for a moment before a worker picks it up, and counting that would overstate the work done).
  const elapsedLabel = (() => {
    const started = job?.startedAt ? new Date(job.startedAt).getTime() : NaN;
    if (!Number.isFinite(started)) return null;
    const seconds = Math.floor((nowMs - started) / 1000);
    if (seconds < 0) return null;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  })();

  // Capped at 99 while the run is live: the last unit is only reported once the pipeline is
  // finishing, and a bar that sits at 100% for the final phase is worse than one that never
  // quite gets there.
  const progressPct =
    progressTotal && progressTotal > 0 ? Math.min(99, Math.round((progressSteps.length / progressTotal) * 100)) : null;

  return (
    <div className="page-new-campaign">
      <div className="page-header">
        <div>
          <h1>New Campaign</h1>
        </div>
      </div>

      {!job && (
        <div className="new-campaign-hero">
          <div className="new-campaign-avatars">
            {AVATAR_EMOJIS.map((emoji, i) => (
              <span key={i} className={`new-campaign-avatar ${i === 0 ? "new-campaign-avatar-bot" : ""}`}>
                {emoji}
              </span>
            ))}
          </div>
          <h2 className="new-campaign-question">
            <span className="new-campaign-word-light">Which</span>{" "}
            <span className="new-campaign-word-accent">page</span> would you like to promote?
          </h2>
          {/* Sets the two-step expectation up front. The old copy promised finished campaigns from
              this one button, which stopped being true when the build moved behind the objective
              card — the user would have been waiting for ads that were never coming. */}
          <p className="new-campaign-subtext">
            Paste your link — 10 research providers analyze the product, audience, competitors and market, and mine
            real Meta Ads interest keywords. You get a strategy first; the ads are written after you set the objective,
            budget and platforms.
          </p>

          {error && <p className="error">{error}</p>}

          <div className="new-campaign-url-row">
            <input
              type="text"
              className="new-campaign-url-input"
              placeholder="Please enter page url"
              value={pageUrl}
              onChange={(e) => setPageUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleStart()}
              disabled={starting}
            />
            <button className="btn btn-primary new-campaign-deep-research-btn" onClick={() => handleStart()} disabled={starting}>
              <span aria-hidden="true">✨</span>
              {starting ? "Starting…" : "Deep Research"}
            </button>
          </div>


          <div className="new-campaign-value-row">
            <div className="new-campaign-value-item">
              <span className="new-campaign-value-icon"><TargetIcon /></span>
              <span>6 audience personas with real Meta Ads interest targeting</span>
            </div>
            <div className="new-campaign-value-item">
              <span className="new-campaign-value-icon"><LightningIcon /></span>
              <span>Genuine budget based on CPC benchmarks &amp; competition</span>
            </div>
            <div className="new-campaign-value-item">
              <span className="new-campaign-value-icon"><SparkleIcon /></span>
              <span>Publication-ready ads that comply with platform policies</span>
            </div>
            <div className="new-campaign-value-item">
              <span className="new-campaign-value-icon"><GlobeIcon /></span>
              <span>Scale from test to millions with tiered growth plan</span>
            </div>
          </div>
        </div>
      )}

      {job && (
        <div className="new-campaign-hero new-campaign-hero--results">
          <div className="new-campaign-resubmit-bar">
            <div className="new-campaign-resubmit-row">
              <span className="new-campaign-resubmit-input">{pageUrl || "Your campaign"}</span>
              <button type="button" className="new-campaign-resubmit-btn" onClick={handleReset}>
                Start over
              </button>
            </div>
          </div>

          {error && <p className="error">{error}</p>}

          {isFailed && (
            <div className="crawler-trace">
              <p className="error">{job.error ?? "Campaign generation failed — try a different URL."}</p>
              <button className="btn btn-secondary" onClick={handleReset}>Try again</button>
            </div>
          )}

          {isActive && (
            <div className="crawler-trace">
              {/* The header and the note under it used to restate the phase list in prose — three
                  descriptions of the same four steps. What isn't in the list is kept: how long
                  it's been running, how far along it is, that leaving is safe, and that nothing
                  has been created yet. */}
              <div className="crawler-trace-header">
                <span>Researching <strong>{pageUrl || "your page"}</strong></span>
                {elapsedLabel && <span className="crawler-trace-elapsed">{elapsedLabel}</span>}
              </div>
              {progressPct !== null && (
                <div
                  className="crawler-trace-bar"
                  role="progressbar"
                  aria-valuenow={progressPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Research progress"
                >
                  <span className="crawler-trace-bar-fill" style={{ width: `${progressPct}%` }} />
                </div>
              )}
              <p className="crawler-trace-time-note">
                Keeps running if you close this page. No ads are created yet — you choose the objective, budget and
                platforms when research finishes.
              </p>
              <ul className="crawler-trace-steps">
                {PHASE_ORDER.map((phase, i) => {
                  const done = currentPhaseIndex > i;
                  const active = currentPhaseIndex === i;
                  const PhaseIcon = phase.icon;
                  // Real steps as they actually complete (GET /campaigns/generate/:id/progress)
                  // take over from the static rotating message the moment any exist — an older
                  // job or a Redis miss just leaves progressSteps empty and the static message
                  // still shows, so this never regresses to a blank line.
                  const liveLine = active && progressSteps.length > 0 ? stepLabel(progressSteps[progressSteps.length - 1]) : null;
                  return (
                    <li key={phase.key} className={done ? "done" : active ? "active" : "pending"}>
                      <div className="crawler-trace-step-row">
                        <span className="crawler-trace-step-badge">
                          {active ? <span className="crawler-trace-spinner" /> : <PhaseIcon />}
                        </span>
                        <span>{phase.label}</span>
                        {done && <span className="crawler-trace-step-done-mark" aria-hidden="true">✓</span>}
                      </div>
                      {active && <p className="phase-subline">{liveLine ? `${liveLine}…` : phaseSubline(phase.key)}</p>}
                    </li>
                  );
                })}
              </ul>
              {progressSteps.length > 0 && progressTotal !== null && (
                <p className="crawler-trace-progress-count">
                  {progressSteps.length} of {progressTotal} steps complete{progressPct !== null && ` · ${progressPct}%`}
                </p>
              )}
            </div>
          )}

          {/* Stream the researched output the moment research completes (mid-run), so the user sees
              what we've learned while agents + strategy still run. Superseded by the full decision
              view below once it lands, so this only shows in the gap between the two. */}
          {isActive && job.researchJobId && !job.decisionContext && (
            <ResearchOutputPreview researchJobId={job.researchJobId} streaming={isActive} />
          )}

          {isDone && <FreshnessBadge job={job} onRefresh={handleRefresh} refreshing={refreshing} />}

          {job.decisionContext && (
            <DecisionContextView
              decision={job.decisionContext}
              url={pageUrl}
              jobId={job.id}
              onSelectStrategy={isDone && !publishedCampaign ? handleSelectStrategy : undefined}
              selectingStrategy={selectingStrategy}
            />
          )}

          {factsVisible && <CompetitorAdsSection jobId={job.id} />}

          {isDone && !publishedCampaign && (
            <div className="all-set-banner">
              <span className="all-set-banner-icon" aria-hidden="true">✓</span>
              {job.campaignId ? (
                <span>Your campaign is ready — real ads have been generated. Publish it paused in one click, or fine-tune it in the builder.</span>
              ) : (
                // Claiming ads exist before they do was the old banner's problem: it said "real ads
                // have been generated" while the user still had to choose what to generate.
                <span>Research complete. Set your objective, budget, platforms and locations below — the ads are written from those choices.</span>
              )}
            </div>
          )}

          {/* Research is done; the ads are NOT written yet (deferBuild). These selections decide
              what gets built, so the card sits here — after the findings the user needs in order
              to choose, and before anything is generated from them. */}
          {isDone && !job.campaignId && !publishedCampaign && (
            <PromotionObjectiveCard
              onGenerate={handleBuildCampaign}
              onChange={setPromoValues}
              generating={publishing}
              generateLabel={publishing ? "Generating…" : "Generate Campaign"}
            />
          )}

          {/* Ads exist — the only decisions left are what to do with them. */}
          {isDone && job.campaignId && !publishedCampaign && (
            <div className="new-campaign-result-actions">
              <button className="btn btn-primary" onClick={() => handlePublish()} disabled={publishing}>
                {publishing ? "Publishing…" : "Publish (paused)"}
              </button>
              <button className="btn btn-secondary" onClick={() => handleGenerateToBuilder()} disabled={publishing}>
                Open in Campaign Builder
              </button>
            </div>
          )}

          {/* Published (PAUSED) — go live + auto-optimize */}
          {publishedCampaign && (
            <div className="publish-live-panel">
              <div className="all-set-banner">
                <span className="all-set-banner-icon" aria-hidden="true">✓</span>
                <span>
                  Published to {publishedCampaign.networks.map((n) => n === "meta" ? "Meta" : "Google").join(" & ")} — {publishedCampaign.variants.filter((v) => v.externalId).length} ad(s) created and <strong>paused</strong>. Nothing spends until you go live.
                </span>
              </div>
              <label className="ncs-optimize-toggle">
                <input type="checkbox" checked={autoOptimize} onChange={(e) => setAutoOptimize(e.target.checked)} />
                <span><strong>24/7 auto-optimize</strong> — automatically shift budget to winning ads and pause underperformers.</span>
              </label>
              <div className="crawler-result-actions">
                <button className="btn btn-primary" onClick={handleGoLive} disabled={goingLive}>
                  {goingLive ? "Going live…" : "Go live"}
                </button>
                <button className="btn btn-secondary" onClick={() => navigate(`/campaigns/${publishedCampaign.id}`)}>
                  View campaign
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
