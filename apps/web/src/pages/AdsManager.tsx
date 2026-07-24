import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, Campaign, AdSet, Ad, AdInsightsResponse, Insight, LiveInsights, NetworkSlice } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { usePageHeader } from "../context/PageHeaderContext.js";
import StatusBadge from "../components/StatusBadge.js";
import Reveal from "../components/Reveal.js";
import ManageFunds from "../components/ManageFunds.js";

type Mode = "campaigns" | "adsets" | "ads";
type Network = "meta" | "google" | "tiktok";

interface BriefStat {
  label: string;
  value: string;
}

const NETWORK_LABELS: Record<Network, string> = { meta: "Meta", google: "Google", tiktok: "Tiktok" };

/** Builds the four overview stat tiles from a real, network-scoped AdInsightsResponse.totals —
 * no historical comparison data exists yet, so there's deliberately no delta/trend arrow here
 * (the old mock version fabricated week-over-week deltas that were never actually computed). */
function statsFromInsights(insights: AdInsightsResponse | null): BriefStat[] {
  if (!insights) return [];
  const t = insights.totals;
  return [
    { label: "Spend", value: `$${(t.spendCents / 100).toFixed(2)}` },
    { label: "Conversions", value: String(t.conversions) },
    { label: "Cost Per Conversion", value: t.cpaCents !== null ? `$${(t.cpaCents / 100).toFixed(2)}` : "—" },
    { label: "ROAS", value: t.roas !== null ? `${t.roas.toFixed(2)}x` : "—" },
  ];
}

/** Summary stat tiles shown above the Ad set / Ad tables — same Total/Active/Paused pattern the
 * Polluxa native Meta/Google ad-set & ad tabs open with, so the hierarchy views feel consistent. */
function SummaryCards({ cards }: { cards: { label: string; value: string | number; accent: string; sub?: string }[] }) {
  return (
    <div className="polluxa-summary-cards">
      {cards.map((c) => (
        <div className="polluxa-summary-card" key={c.label} style={{ borderTopColor: c.accent }}>
          <div className="polluxa-summary-card-label">{c.label}</div>
          <div className="polluxa-summary-card-value">{c.value}</div>
          {c.sub && <div className="polluxa-summary-card-sub">{c.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function ToggleSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`polluxa-toggle-switch ${on ? "on" : ""}`}
      onClick={onToggle}
      aria-pressed={on}
      aria-label={on ? "Turn off" : "Turn on"}
    >
      <span className="polluxa-toggle-knob" />
    </button>
  );
}

function PagerCard({
  variant,
  icon,
  title,
  items,
}: {
  variant: "highlight" | "risk";
  icon: string;
  title: string;
  items: string[];
}) {
  const [idx, setIdx] = useState(0);
  const total = items.length;

  useEffect(() => {
    setIdx(0);
  }, [items]);

  return (
    <div className={`polluxa-pager-card ${variant}`}>
      <div className="polluxa-pager-card-head">
        <span className="polluxa-pager-card-title">
          <span className="polluxa-pager-card-icon">{icon}</span> {title}
        </span>
        <span className="polluxa-pager-nav">
          <button type="button" onClick={() => setIdx((idx - 1 + total) % total)} aria-label="Previous">‹</button>
          <span>{idx + 1}/{total}</span>
          <button type="button" onClick={() => setIdx((idx + 1) % total)} aria-label="Next">›</button>
        </span>
      </div>
      <p className="polluxa-pager-card-body">{items[idx]}</p>
    </div>
  );
}

export default function AdsManager({ businessId }: { businessId: string }) {
  const { workspaceId } = useAuth();
  const wsId = localStorage.getItem("polluxa_workspace_id") ?? "demo-workspace";
  // Deep-link params from the Campaigns "View" button: ?campaign=<id>&mode=adsets scopes the
  // hub to a single campaign's ad sets / ads (so "View" opens that campaign's sets here instead
  // of the old standalone detail page). Cleared via the scope banner's "×".
  const [searchParams, setSearchParams] = useSearchParams();
  const scopedCampaignId = searchParams.get("campaign");
  const urlMode = searchParams.get("mode");
  const [mode, setMode] = useState<Mode>(urlMode === "adsets" || urlMode === "ads" ? urlMode : "campaigns");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [adSets, setAdSets] = useState<AdSet[]>([]);
  const [ads, setAds] = useState<Ad[]>([]);
  const [liveInsightsByCampaign, setLiveInsightsByCampaign] = useState<Record<string, LiveInsights>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [network, setNetwork] = useState<Network>("meta");
  const [adInsights, setAdInsights] = useState<AdInsightsResponse | null>(null);

  // Push the page-specific "Manage Funds" widget into the shared shell header (the connected
  // Meta ad account's real balance + wallet ledger). Meta-scoped — funds are per Meta ad account.
  usePageHeader({
    breadcrumb: ["AI Optimize", "Ads Manager"],
    rightSlot: network === "meta" && workspaceId ? <ManageFunds workspaceId={workspaceId} /> : null,
    rightSlotDeps: [network, workspaceId],
  });
  const [aiInsights, setAiInsights] = useState<Insight[]>([]);
  const [generatingAi, setGeneratingAi] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(true);
  const [applyMode, setApplyMode] = useState<"recommended" | "auto">("auto");

  // Editable optimization rule (goal + constraint the auto-optimizer targets) — mirrors AdsGo's
  // "Budget $500, PURCHASE, CPA↓" editable rule instead of a read-only summary. Persisted per
  // workspace so it survives reload; the budget mirrors the campaigns' combined daily budget.
  const [ruleGoal, setRuleGoal] = useState<string>(() => localStorage.getItem("polluxa_opt_goal") ?? "PURCHASE");
  const [ruleConstraint, setRuleConstraint] = useState<string>(() => localStorage.getItem("polluxa_opt_constraint") ?? "CPA_DOWN");
  const [editingRule, setEditingRule] = useState(false);
  const OPT_GOALS = ["PURCHASE", "LEADS", "TRAFFIC", "AWARENESS", "APP_INSTALLS"];
  const OPT_CONSTRAINTS: { value: string; label: string }[] = [
    { value: "CPA_DOWN", label: "Lower CPA ↓" },
    { value: "ROAS_UP", label: "Maximize ROAS ↑" },
    { value: "CPC_DOWN", label: "Lower CPC ↓" },
    { value: "SPEND_CAP", label: "Cap spend" },
  ];
  function saveRule(goal: string, constraint: string) {
    setRuleGoal(goal);
    setRuleConstraint(constraint);
    localStorage.setItem("polluxa_opt_goal", goal);
    localStorage.setItem("polluxa_opt_constraint", constraint);
  }

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [onIds, setOnIds] = useState<Set<string>>(new Set());
  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Reporting window for the live metrics — maps to Meta date_preset values on the backend.
  const RANGE_OPTIONS: { value: string; label: string }[] = [
    { value: "today", label: "Today" },
    { value: "last_7d", label: "Last 7 days" },
    { value: "last_14d", label: "Last 14 days" },
    { value: "last_30d", label: "Last 30 days" },
    { value: "last_90d", label: "Last 90 days" },
    { value: "maximum", label: "All time" },
  ];
  const [range, setRange] = useState<string>("last_14d");

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const camps = await api.listCampaigns(businessId);
      setCampaigns(camps);
      setOnIds(new Set(camps.filter((c) => c.status === "active").map((c) => c.id)));

      const setsByCampaign = await Promise.all(camps.map((c) => api.listAdSets(c.id).catch(() => [])));
      const allSets = setsByCampaign.flat();
      setAdSets(allSets);

      const adsBySet = await Promise.all(allSets.map((s) => api.listAds(s.id).catch(() => [])));
      setAds(adsBySet.flat());

      const liveInsightsList = await Promise.all(camps.map((c) => api.getLiveInsights(c.id, range).catch(() => null)));
      setLiveInsightsByCampaign(Object.fromEntries(camps.map((c, i) => [c.id, liveInsightsList[i]]).filter(([, v]) => v)));
    } catch (err) {
      setError("Failed to load Ads Manager hierarchy data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, range]);

  useEffect(() => {
    api.getAdInsights(businessId, network).then(setAdInsights).catch(() => setAdInsights(null));
  }, [businessId, network]);

  // Real AI-generated analysis (insightService.ts, OpenAI-backed) is generated lazily on first
  // view rather than on a timer — avoids paying for a model call for every business regardless
  // of whether anyone is actually looking at this page.
  useEffect(() => {
    let cancelled = false;
    api.listInsights(wsId).then(async (list) => {
      if (cancelled) return;
      if (list.length > 0) {
        setAiInsights(list);
        return;
      }
      try {
        const generated = await api.generateInsights(wsId, businessId);
        if (!cancelled) setAiInsights(generated);
      } catch {
        // leave aiInsights empty — the overview falls back to a "no analysis yet" message
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  async function handleRefreshAiAnalysis() {
    setGeneratingAi(true);
    try {
      const generated = await api.generateInsights(wsId, businessId);
      setAiInsights(generated);
    } catch {
      // keep showing whatever analysis was already on screen
    } finally {
      setGeneratingAi(false);
    }
  }

  useEffect(() => {
    setPage(1);
  }, [mode, searchTerm, statusFilter, pageSize, network]);

  function bucketFor(c: Campaign, _index: number): "scaleUp" | "scaleDown" | "pause" | "maintain" {
    if (c.status !== "active") return "maintain";
    const li = liveInsightsByCampaign[c.id];
    if (!li) return "maintain";
    if (li.roas !== null && li.roas >= 2) return "scaleUp";
    if (li.roas !== null && li.roas > 0 && li.roas < 0.8) return "scaleDown";
    if (li.spendCents > 0 && li.conversions === 0 && li.clicks > 20) return "pause";
    return "maintain";
  }

  function recommendedBudgetCents(c: Campaign, index: number): number {
    const bucket = bucketFor(c, index);
    if (bucket === "scaleUp") return Math.round(c.dailyBudgetCents * 1.2);
    if (bucket === "scaleDown") return Math.round(c.dailyBudgetCents * 0.85);
    if (bucket === "pause") return Math.round(c.dailyBudgetCents * 0.3);
    return c.dailyBudgetCents;
  }

  // Human-readable rationale for each recommendation, grounded in the campaign's real live metrics
  // (the same LiveInsights the bucket decision is derived from) — this is the "Reason" column that
  // makes a budget move explainable rather than a bare arrow. Returns "" for campaigns with no
  // actionable recommendation so the cell shows a dash.
  function reasonFor(c: Campaign, index: number): string {
    const bucket = bucketFor(c, index);
    const li = liveInsightsByCampaign[c.id];
    if (bucket === "maintain") {
      if (!li || li.spendCents === 0) return "No spend yet — not enough data to recommend a change.";
      return "Performing within target — hold budget.";
    }
    const roasStr = li?.roas != null ? `${li.roas.toFixed(2)}x ROAS` : "no return yet";
    const spendStr = li ? `$${(li.spendCents / 100).toFixed(2)} spent` : "";
    if (bucket === "scaleUp") return `Strong efficiency (${roasStr}) — scale budget +20% to capture more volume.`;
    if (bucket === "scaleDown") return `Below-target return (${roasStr}, ${spendStr}) — trim budget 15% to protect margin.`;
    if (bucket === "pause") return `${spendStr} with ${li?.clicks ?? 0} clicks and 0 conversions — pause to stop wasted spend.`;
    return "";
  }

  const optSummary = useMemo(() => {
    const counts = { scaleUp: 0, scaleDown: 0, pause: 0, maintain: 0 };
    let currentCents = 0;
    let recommendCents = 0;
    // Scope the hub to the active network tab (a campaign belongs to `network` if its `networks`
    // array includes it; untagged legacy campaigns default to Meta) so the Scale/Pause counts and
    // budget totals match the campaigns actually listed under this tab.
    campaigns
      .filter((c) => (c.networks?.length ? c.networks.includes(network as "meta" | "google") : network === "meta"))
      .forEach((c, i) => {
        counts[bucketFor(c, i)]++;
        currentCents += c.dailyBudgetCents;
        recommendCents += recommendedBudgetCents(c, i);
      });
    return { counts, currentCents, recommendCents };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaigns, network]);

  function handleSelectRow(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function handleSelectAll(checked: boolean) {
    if (checked) {
      if (mode === "campaigns") setSelectedIds(filteredCampaigns.map((c) => c.id));
      if (mode === "adsets") setSelectedIds(filteredAdSets.map((s) => s.id));
      if (mode === "ads") setSelectedIds(filteredAds.map((a) => a.id));
    } else {
      setSelectedIds([]);
    }
  }

  // Persist a status change for one campaign: pause/activate its live variants on the ad network
  // when it has any, otherwise flip the campaign's own status. Mirrors toggleOn's persistence so
  // the bulk action actually reaches the server (the old bulk-pause only touched local state).
  async function persistCampaignStatus(id: string, target: "active" | "paused") {
    const camp = campaigns.find((c) => c.id === id);
    if (!camp) return;
    const liveVariants = (camp.variants ?? []).filter((v) => v.externalId);
    if (liveVariants.length === 0) {
      await api.updateCampaign(id, { status: target } as any);
      return;
    }
    if (target === "paused") {
      for (const v of liveVariants.filter((v) => v.status === "active")) await api.pauseVariant(id, v.id);
    } else {
      for (const v of liveVariants.filter((v) => v.status === "paused")) await api.activateVariant(id, v.id);
    }
  }

  async function handleBulkStatus(target: "active" | "paused") {
    // Activating spends real budget — gate it behind an explicit confirm, same as single-variant activate.
    if (target === "active" && !confirm(`Activate ${selectedIds.length} campaign(s)? Active campaigns spend your budget.`)) return;
    const ids = [...selectedIds];
    try {
      await Promise.all(ids.map((id) => persistCampaignStatus(id, target)));
      setOnIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => (target === "active" ? next.add(id) : next.delete(id)));
        return next;
      });
      await loadData();
    } catch {
      setError(`Some campaigns failed to ${target === "paused" ? "pause" : "activate"}.`);
    }
    setSelectedIds([]);
  }

  async function handleBulkDuplicate() {
    setError("Duplicate feature is coming soon.");
    setSelectedIds([]);
  }

  async function toggleOn(id: string) {
    const isOn = onIds.has(id);
    const target = isOn ? "paused" : "active";
    setOnIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    try {
      await persistCampaignStatus(id, target);
    } catch {
      // Revert the optimistic toggle if the network call failed.
      setOnIds((prev) => {
        const next = new Set(prev);
        if (isOn) next.add(id);
        else next.delete(id);
        return next;
      });
    }
  }

  // Lookups so the ad-set / ad tables can show their parent (Campaign / Ad Set) columns and derive
  // each row's network — the same hierarchy context Polluxa's native Meta/Google tables surface.
  const campaignById = useMemo(() => Object.fromEntries(campaigns.map((c) => [c.id, c])), [campaigns]);
  const adSetById = useMemo(() => Object.fromEntries(adSets.map((s) => [s.id, s])), [adSets]);

  // When deep-linked to a specific campaign, switch the network tab to one that campaign actually
  // runs on — otherwise a Google-only campaign opened via "View" would show no ad sets under the
  // default Meta tab. Runs once the campaign is loaded; prefers Meta when the campaign spans both.
  useEffect(() => {
    if (!scopedCampaignId) return;
    const c = campaigns.find((x) => x.id === scopedCampaignId);
    if (!c) return;
    const nets = c.networks?.length ? c.networks : ["meta"];
    if (!nets.includes(network as "meta" | "google")) {
      setNetwork(nets.includes("meta") ? "meta" : (nets[0] as Network));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedCampaignId, campaigns]);

  // The active network tab scopes the tables (Meta tab shows only Meta campaigns, etc.). A campaign
  // belongs to the tab's network if its `networks` array includes it; ad sets/ads inherit the
  // network of their parent campaign. Campaigns predating multi-network tagging (empty `networks`)
  // default to Meta so they don't vanish from every tab.
  const campaignOnNetwork = (c: Campaign) => (c.networks?.length ? c.networks.includes(network as "meta" | "google") : network === "meta");
  const adSetOnNetwork = (s: AdSet) => { const p = campaignById[s.campaignId]; return p ? campaignOnNetwork(p) : network === "meta"; };
  const adOnNetwork = (a: Ad) => { const p = adSetById[a.adSetId]; return p ? adSetOnNetwork(p) : network === "meta"; };

  // The active network's metric slice for a campaign — a dual-network campaign shows only its Meta
  // numbers under the Meta tab and only its Google numbers under Google, with the daily budget split
  // proportionally (see the /live-insights byNetwork breakdown). Falls back to the campaign-wide
  // aggregate for older responses that predate byNetwork (backward-compatible).
  const sliceFor = (c: Campaign): (NetworkSlice | LiveInsights) & { dailyBudgetCents?: number } | undefined => {
    const li = liveInsightsByCampaign[c.id];
    return li?.byNetwork?.[network as "meta" | "google"] ?? li;
  };
  // The network's share of a campaign's daily budget (from the slice when present, else the full budget).
  const budgetForNetwork = (c: Campaign): number => {
    const slice = sliceFor(c) as NetworkSlice | undefined;
    return slice && "dailyBudgetCents" in slice && slice.dailyBudgetCents != null ? slice.dailyBudgetCents : c.dailyBudgetCents;
  };

  // When deep-linked from a campaign's "View", scope ad sets/ads to that campaign only. Ads belong
  // to the campaign via their parent ad set. Campaigns list is unaffected (scope only narrows the
  // hierarchy views the View button opens into).
  const scopedCampaign = scopedCampaignId ? campaignById[scopedCampaignId] : undefined;
  const adSetInScope = (s: AdSet) => !scopedCampaignId || s.campaignId === scopedCampaignId;
  const adInScope = (a: Ad) => {
    if (!scopedCampaignId) return true;
    const parentSet = adSetById[a.adSetId];
    return parentSet ? parentSet.campaignId === scopedCampaignId : false;
  };

  const filteredCampaigns = campaigns
    .filter(campaignOnNetwork)
    .filter((c) => c.name.toLowerCase().includes(searchTerm.toLowerCase()))
    .filter((c) => statusFilter === "all" || c.status === statusFilter);
  const filteredAdSets = adSets
    .filter(adSetOnNetwork)
    .filter(adSetInScope)
    .filter((s) => s.name.toLowerCase().includes(searchTerm.toLowerCase()))
    .filter((s) => statusFilter === "all" || s.status === statusFilter);
  const filteredAds = ads
    .filter(adOnNetwork)
    .filter(adInScope)
    .filter((a) => a.name.toLowerCase().includes(searchTerm.toLowerCase()))
    .filter((a) => statusFilter === "all" || a.status === statusFilter);

  const totalItems = mode === "campaigns" ? filteredCampaigns.length : mode === "adsets" ? filteredAdSets.length : filteredAds.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const pageStart = (page - 1) * pageSize;

  const pagedCampaigns = filteredCampaigns.slice(pageStart, pageStart + pageSize);
  const pagedAdSets = filteredAdSets.slice(pageStart, pageStart + pageSize);
  const pagedAds = filteredAds.slice(pageStart, pageStart + pageSize);

  // Header/summary figures are scoped to the active network tab so they agree with the visible rows,
  // using each campaign's network slice (split budget) rather than the campaign-wide aggregate.
  const networkCampaigns = campaigns.filter(campaignOnNetwork);
  const activeCount = networkCampaigns.filter((c) => c.status === "active").length;
  const totalBudgetCents = networkCampaigns.reduce((sum, c) => sum + budgetForNetwork(c), 0);

  // Column totals for the campaign table's Total row, summed across the active network's campaigns
  // (including the funnel breakdown). CPM/CPC/ROAS totals are derived from these sums downstream.
  const totals = useMemo(() => {
    return networkCampaigns
      .map((c) => sliceFor(c))
      .filter(Boolean)
      .reduce(
      (acc, li: any) => ({
        spendCents: acc.spendCents + li.spendCents,
        impressions: acc.impressions + li.impressions,
        clicks: acc.clicks + li.clicks,
        conversions: acc.conversions + li.conversions,
        revenueCents: acc.revenueCents + (li.funnel?.purchaseValueCents ?? Math.round((li.roas ?? 0) * li.spendCents)),
        addToCart: acc.addToCart + (li.funnel?.addToCart ?? 0),
        purchases: acc.purchases + (li.funnel?.purchases ?? 0),
      }),
      { spendCents: 0, impressions: 0, clicks: 0, conversions: 0, revenueCents: 0, addToCart: 0, purchases: 0 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveInsightsByCampaign, campaigns, network]);

  // Human-readable targeting bits pulled from the ad set's real targeting blob (shapes vary by
  // network — Meta uses geo_locations/age_min/genders, Google uses geoTargetConstants/ageRanges),
  // so each getter is defensive and falls back to "—" rather than fabricating a value.
  function adSetLocation(s: AdSet): string {
    const t = s.targeting as any;
    const geo = t?.geo_locations?.countries ?? t?.geoTargetConstants ?? t?.countries;
    if (Array.isArray(geo) && geo.length) return geo.slice(0, 2).join(", ") + (geo.length > 2 ? ` +${geo.length - 2}` : "");
    return "All";
  }
  function adSetObjective(s: AdSet): string {
    const t = s.targeting as any;
    return t?.optimization_goal ?? t?.optimizationGoal ?? s.bidStrategy ?? "—";
  }

  // Ad-set / ad summary counts for the stat-card row (mirrors Polluxa's Total/Active/Paused tiles).
  // Scoped to the active network so the tiles match the filtered table below them.
  const networkAdSets = adSets.filter(adSetOnNetwork);
  const networkAds = ads.filter(adOnNetwork);
  const adSetActive = networkAdSets.filter((s) => s.status === "active").length;
  const adSetPaused = networkAdSets.filter((s) => s.status === "paused").length;
  const adActive = networkAds.filter((a) => a.status === "active").length;
  const adPaused = networkAds.filter((a) => a.status === "paused").length;

  const rangeLabel = RANGE_OPTIONS.find((r) => r.value === range)?.label ?? "All time";
  const briefTitle = `${NETWORK_LABELS[network]} Ads Insights Brief`;
  const briefStats = statsFromInsights(adInsights);
  const activeAiInsights = aiInsights.filter((i) => !i.dismissed);
  const mainNarrative = activeAiInsights[0]
    ? `${activeAiInsights[0].title} — ${activeAiInsights[0].description}`
    : "No AI analysis yet for this business — click refresh to generate one from current performance data.";
  const highlights = activeAiInsights.filter((i) => i.type !== "anomaly").map((i) => `${i.title} — ${i.description}`);
  const risks = activeAiInsights.filter((i) => i.type === "anomaly").map((i) => `${i.title} — ${i.description}`);

  return (
    <div className="polluxa-ads-page">
      {error && <p className="error">{error}</p>}

      {/* Overview */}
      <div className="polluxa-overview-card">
        <div className="polluxa-overview-header">
          <h2 className="polluxa-overview-title">Overview</h2>
          <div className="polluxa-network-tabs">
            {(["meta", "google", "tiktok"] as Network[]).map((n) => {
              // Only Meta + Google are live; TikTok is a disabled "Coming soon" tab.
              const comingSoon = n === "tiktok";
              return (
                <button
                  key={n}
                  type="button"
                  className={`polluxa-network-tab ${network === n ? "active" : ""} ${comingSoon ? "disabled" : ""}`}
                  onClick={() => { if (!comingSoon) setNetwork(n); }}
                  disabled={comingSoon}
                  title={comingSoon ? "Coming soon" : undefined}
                  style={comingSoon ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
                >
                  {NETWORK_LABELS[n]}{comingSoon ? " — Coming soon" : ""}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className={`polluxa-collapse-btn ${overviewOpen ? "open" : ""}`}
            onClick={() => setOverviewOpen((o) => !o)}
            aria-label="Toggle overview"
          >
            ▲
          </button>
        </div>

        {overviewOpen && (
          <div className="polluxa-overview-body">
            <div className="polluxa-overview-grid">
              {/* Left column: insights */}
              <div className="polluxa-insights-col">
                <div className="polluxa-brief-card">
                  <div className="polluxa-brief-card-head">
                    <div>
                      <span className="polluxa-brief-title">
                        {briefTitle} {adInsights?.isDemo && <span className="polluxa-demo-badge">Demo</span>}
                      </span>
                      <div className="polluxa-brief-period">{rangeLabel}</div>
                    </div>
                    <button type="button" className="polluxa-icon-btn" onClick={loadData} aria-label="Refresh">
                      ↻
                    </button>
                  </div>
                  <div className="polluxa-stat-grid">
                    {briefStats.map((s) => (
                      <div className="polluxa-stat-tile" key={s.label}>
                        <div className="polluxa-stat-tile-head">
                          <span title={s.label}>{s.label}</span>
                        </div>
                        <div className="polluxa-stat-value">{s.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="polluxa-analysis-row">
                  <div className="polluxa-analysis-card">
                    <div className="polluxa-analysis-head">
                      <span className="polluxa-analysis-icon">✓</span>
                      <span>AI Analysis Insights</span>
                      <button type="button" className="polluxa-icon-btn polluxa-ai-refresh-btn" onClick={handleRefreshAiAnalysis} disabled={generatingAi} aria-label="Refresh AI analysis">
                        {generatingAi ? "…" : "↻"}
                      </button>
                    </div>
                    <p className="polluxa-analysis-body">{mainNarrative}</p>
                  </div>
                  <div className="polluxa-side-cards">
                    <PagerCard variant="highlight" icon="↗" title="Key Highlight" items={highlights.length > 0 ? highlights : ["No highlights yet — refresh to generate AI analysis."]} />
                    <PagerCard variant="risk" icon="⚠" title="Potential Risk" items={risks.length > 0 ? risks : ["No risks identified from current data."]} />
                  </div>
                </div>
              </div>

              {/* Right column: optimization hub */}
              <div className="polluxa-opt-col">
                <div className="polluxa-opt-hub-card">
                  <div className="polluxa-opt-hub-head">
                    <span className="polluxa-opt-hub-icon">◎</span>
                    <div>
                      <div className="polluxa-opt-hub-title">Optimization Hub</div>
                      <div className="polluxa-opt-hub-updated">Last update: {new Date().toTimeString().slice(0, 5)}</div>
                    </div>
                  </div>

                  {editingRule ? (
                    <div className="polluxa-opt-rule-editor">
                      <span className="polluxa-opt-rule-icon">◎</span>
                      <span className="polluxa-opt-rule-static">Budget ${(totalBudgetCents / 100).toFixed(0)}/day</span>
                      <select value={ruleGoal} onChange={(e) => setRuleGoal(e.target.value)} aria-label="Optimization goal">
                        {OPT_GOALS.map((g) => <option key={g} value={g}>{g}</option>)}
                      </select>
                      <select value={ruleConstraint} onChange={(e) => setRuleConstraint(e.target.value)} aria-label="Optimization constraint">
                        {OPT_CONSTRAINTS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                      <button type="button" className="polluxa-accept-btn" onClick={() => { saveRule(ruleGoal, ruleConstraint); setEditingRule(false); }}>Save</button>
                    </div>
                  ) : (
                    <button type="button" className="polluxa-opt-rule-pill" onClick={() => setEditingRule(true)} title="Edit optimization rule">
                      <span className="polluxa-opt-rule-icon">◎</span> Budget ${(totalBudgetCents / 100).toFixed(0)}/day · {ruleGoal} · {OPT_CONSTRAINTS.find((c) => c.value === ruleConstraint)?.label ?? ruleConstraint}
                      <span className="polluxa-opt-rule-edit-icon"> ✎</span>
                    </button>
                  )}

                  <div className="polluxa-opt-summary-title">Summary</div>
                  <div className="polluxa-opt-summary-grid">
                    <div className="polluxa-opt-summary-item scaleup">
                      <span className="polluxa-opt-summary-count">{optSummary.counts.scaleUp}</span>
                      <span>Scale Up</span>
                    </div>
                    <div className="polluxa-opt-summary-item scaledown">
                      <span className="polluxa-opt-summary-count">{optSummary.counts.scaleDown}</span>
                      <span>Scale Down</span>
                    </div>
                    <div className="polluxa-opt-summary-item pause">
                      <span className="polluxa-opt-summary-count">{optSummary.counts.pause}</span>
                      <span>Pause</span>
                    </div>
                    <div className="polluxa-opt-summary-item maintain">
                      <span className="polluxa-opt-summary-count">{optSummary.counts.maintain}</span>
                      <span>Maintain</span>
                    </div>
                  </div>

                  <div className="polluxa-opt-budget-row">
                    <div>
                      <div className="polluxa-opt-budget-label">Current</div>
                      <div className="polluxa-opt-budget-value">${(optSummary.currentCents / 100).toFixed(0)}</div>
                    </div>
                    <div>
                      <div className="polluxa-opt-budget-label">Recommend</div>
                      <div className="polluxa-opt-budget-value accent">${(optSummary.recommendCents / 100).toFixed(0)}</div>
                    </div>
                    <div>
                      <div className="polluxa-opt-budget-label">Adjustment</div>
                      <div className={`polluxa-opt-budget-value ${optSummary.recommendCents >= optSummary.currentCents ? "up" : "down"}`}>
                        {optSummary.recommendCents >= optSummary.currentCents ? "↑" : "↓"} $
                        {Math.abs(optSummary.recommendCents - optSummary.currentCents) / 100}
                      </div>
                    </div>
                  </div>

                  <div className="polluxa-opt-mode-grid">
                    <div
                      className={`polluxa-opt-mode-card ${applyMode === "recommended" ? "selected" : ""}`}
                      onClick={() => setApplyMode("recommended")}
                    >
                      <span className="polluxa-opt-mode-icon">⟲</span>
                      <span>Recommended only</span>
                      <span className="polluxa-opt-mode-status">{applyMode === "recommended" ? "Selected" : "Off"}</span>
                    </div>
                    <div
                      className={`polluxa-opt-mode-card ${applyMode === "auto" ? "selected" : ""}`}
                      onClick={() => setApplyMode("auto")}
                    >
                      {applyMode === "auto" && <span className="polluxa-best-choice-tag">Best choice</span>}
                      <span className="polluxa-opt-mode-icon">∞</span>
                      <span>Auto-apply</span>
                      <span className="polluxa-opt-mode-status">{applyMode === "auto" ? "Selected" : "Off"}</span>
                    </div>
                  </div>

                  <div className="polluxa-opt-schedule-row">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                      <line x1="16" y1="2" x2="16" y2="6" />
                      <line x1="8" y1="2" x2="8" y2="6" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                    Continuous optimization · updates on every refresh
                  </div>
                </div>
              </div>
            </div>

            {campaigns.length === 0 && !loading && (
              <div className="polluxa-demo-banner">
                <div className="polluxa-demo-banner-inner">
                  <span className="polluxa-demo-banner-icon">ⓘ</span>
                  <span className="polluxa-demo-banner-text">Demo data only. Create your first campaign to view performance data.</span>
                  <Link to="/campaigns/new" className="btn btn-primary polluxa-demo-banner-btn">✨ Create campaign</Link>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Table section */}
      <div className="polluxa-table-section">
        {scopedCampaignId && (
          <div className="polluxa-scope-banner">
            <span className="polluxa-scope-banner-text">
              Viewing <strong>{scopedCampaign?.name ?? "campaign"}</strong> — its ad sets and ads
            </span>
            <button
              type="button"
              className="polluxa-scope-banner-clear"
              onClick={() => { setSearchParams({}); setMode("campaigns"); }}
            >
              ✕ Show all campaigns
            </button>
          </div>
        )}
        <div className="polluxa-table-tabs">
          <button className={`polluxa-table-tab ${mode === "campaigns" ? "active" : ""}`} onClick={() => { setMode("campaigns"); setSelectedIds([]); }}>
            📁 Campaign
          </button>
          <button className={`polluxa-table-tab ${mode === "adsets" ? "active" : ""}`} onClick={() => { setMode("adsets"); setSelectedIds([]); }}>
            ▦ Ad set
          </button>
          <button className={`polluxa-table-tab ${mode === "ads" ? "active" : ""}`} onClick={() => { setMode("ads"); setSelectedIds([]); }}>
            📄 Ad
          </button>
        </div>

        {mode === "adsets" && (
          <SummaryCards cards={[
            { label: "Total Ad Sets", value: networkAdSets.length, accent: "#1A6BFF" },
            { label: "Active", value: adSetActive, accent: "#16A34A", sub: "Running now" },
            { label: "Paused", value: adSetPaused, accent: "#D97706", sub: "Temporarily stopped" },
            { label: "Campaigns", value: networkCampaigns.length, accent: "#7C3AED", sub: "Parent campaigns" },
          ]} />
        )}
        {mode === "ads" && (
          <SummaryCards cards={[
            { label: "Total Ads", value: networkAds.length, accent: "#1A6BFF" },
            { label: "Active", value: adActive, accent: "#16A34A", sub: "Running now" },
            { label: "Paused", value: adPaused, accent: "#D97706", sub: "Temporarily stopped" },
            { label: "Ad Sets", value: networkAdSets.length, accent: "#7C3AED", sub: "Parent ad sets" },
          ]} />
        )}

        <div className="polluxa-table-filter-row">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Campaign..."
            className="search-input"
            style={{ maxWidth: 220 }}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="polluxa-account-select">
            <option value="all">Ad account: All</option>
            <option value="active">Active Only</option>
            <option value="paused">Paused Only</option>
          </select>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="polluxa-account-select polluxa-range-select"
            aria-label="Reporting date range"
          >
            {RANGE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        {selectedIds.length > 0 && (
          <div className="bulk-actions-bar">
            <span>{selectedIds.length} Selected</span>
            <button className="btn btn-sm btn-secondary" onClick={() => handleBulkStatus("active")}>▶ Activate</button>
            <button className="btn btn-sm btn-secondary" onClick={() => handleBulkStatus("paused")}>⏸ Pause</button>
            <button className="btn btn-sm btn-secondary" onClick={handleBulkDuplicate}>📋 Duplicate</button>
          </div>
        )}

        {loading ? (
          <div className="campaigns-loading">
            {[1, 2, 3].map((i) => <div key={i} className="campaign-row-skeleton" />)}
          </div>
        ) : (
          <Reveal>
            <div className="polluxa-manager-table-wrap">
              <table className="polluxa-manager-table">
                {mode === "campaigns" && (
                  <>
                    <thead>
                      <tr>
                        <th style={{ width: 40 }}>
                          <input
                            type="checkbox"
                            onChange={(e) => handleSelectAll(e.target.checked)}
                            checked={selectedIds.length === filteredCampaigns.length && filteredCampaigns.length > 0}
                          />
                        </th>
                        <th style={{ width: 60 }}>Off/On</th>
                        <th>Advertising Campaign</th>
                        <th>Status</th>
                        <th>Location</th>
                        <th>Goal</th>
                        <th>Daily Budget</th>
                        <th>Spend</th>
                        <th>Impressions</th>
                        <th>CPM</th>
                        <th>Clicks</th>
                        <th>CPC (CTR)</th>
                        <th>Add To Cart</th>
                        <th>Cost / ATC (CVR)</th>
                        <th>Purchases</th>
                        <th>Cost / Purchase</th>
                        <th>Purchase Value (ROAS)</th>
                        <th>Recommend</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="polluxa-total-row">
                        <td></td>
                        <td></td>
                        <td>
                          <strong>Total</strong>
                          <div className="polluxa-total-sub">{activeCount}/{networkCampaigns.length} Active</div>
                        </td>
                        <td>-</td>
                        <td>-</td>
                        <td>-</td>
                        <td>${(totalBudgetCents / 100).toFixed(2)}</td>
                        <td>${(totals.spendCents / 100).toFixed(2)}</td>
                        <td>{totals.impressions.toLocaleString()}</td>
                        <td>{totals.impressions > 0 ? `$${(totals.spendCents / (totals.impressions / 1000) / 100).toFixed(2)}` : "—"}</td>
                        <td>{totals.clicks.toLocaleString()}</td>
                        <td>{totals.clicks > 0 ? `$${(totals.spendCents / totals.clicks / 100).toFixed(2)}` : "—"}</td>
                        <td>{totals.addToCart.toLocaleString()}</td>
                        <td>{totals.addToCart > 0 ? `$${(totals.spendCents / totals.addToCart / 100).toFixed(2)}` : "—"}</td>
                        <td>{totals.purchases.toLocaleString()}</td>
                        <td>{totals.purchases > 0 ? `$${(totals.spendCents / totals.purchases / 100).toFixed(2)}` : "—"}</td>
                        <td>{totals.spendCents > 0 && totals.revenueCents > 0 ? `${(totals.revenueCents / totals.spendCents).toFixed(2)}x` : "—"}</td>
                        <td>-</td>
                        <td>-</td>
                      </tr>
                      {pagedCampaigns.map((c, i) => {
                        const globalIndex = pageStart + i;
                        const bucket = bucketFor(c, globalIndex);
                        const recommendedCents = recommendedBudgetCents(c, globalIndex);
                        const hasSuggestion = bucket !== "maintain" && !acceptedIds.has(c.id) && !dismissedIds.has(c.id);
                        const li = sliceFor(c);
                        return (
                          <tr key={c.id}>
                            <td>
                              <input
                                type="checkbox"
                                checked={selectedIds.includes(c.id)}
                                onChange={() => handleSelectRow(c.id)}
                              />
                            </td>
                            <td>
                              <ToggleSwitch on={onIds.has(c.id)} onToggle={() => toggleOn(c.id)} />
                            </td>
                            <td>
                              <div className="polluxa-campaign-cell">
                                <strong>{c.name}</strong>
                                <span className="polluxa-campaign-id">({c.id})</span>
                              </div>
                            </td>
                            <td>
                              <StatusBadge status={c.status} />
                            </td>
                            <td>
                              <span className="polluxa-pill location">{c.locations?.[0] || "All"}</span>
                            </td>
                            <td>
                              <span className="polluxa-pill goal">{c.conversionEvent || "Conversions"}</span>
                            </td>
                            <td>${(budgetForNetwork(c) / 100).toFixed(2)}</td>
                            <td>{li ? `$${(li.spendCents / 100).toFixed(2)}` : "—"}</td>
                            <td>{li ? li.impressions.toLocaleString() : "—"}</td>
                            <td>{li?.cpmCents != null ? `$${(li.cpmCents / 100).toFixed(2)}` : "—"}</td>
                            <td>{li ? li.clicks.toLocaleString() : "—"}</td>
                            <td>
                              {li?.cpcCents != null ? `$${(li.cpcCents / 100).toFixed(2)}` : "—"}
                              {li ? <span className="polluxa-metric-sub"> ({li.ctr.toFixed(2)}%)</span> : null}
                            </td>
                            <td>{li?.funnel ? li.funnel.addToCart.toLocaleString() : "—"}</td>
                            <td>
                              {li?.costPerAddToCartCents != null ? `$${(li.costPerAddToCartCents / 100).toFixed(2)}` : "—"}
                              {li?.addToCartRate != null ? <span className="polluxa-metric-sub"> ({(li.addToCartRate * 100).toFixed(2)}%)</span> : null}
                            </td>
                            <td>{li?.funnel ? li.funnel.purchases.toLocaleString() : "—"}</td>
                            <td>
                              {li?.costPerPurchaseCents != null ? `$${(li.costPerPurchaseCents / 100).toFixed(2)}` : "—"}
                              {li?.purchaseRate != null ? <span className="polluxa-metric-sub"> ({(li.purchaseRate * 100).toFixed(2)}%)</span> : null}
                            </td>
                            <td>
                              {li?.funnel ? `$${(li.funnel.purchaseValueCents / 100).toFixed(2)}` : "—"}
                              {li?.roas != null ? <span className="polluxa-metric-sub"> ({li.roas.toFixed(2)}x)</span> : null}
                            </td>
                            <td>
                              {hasSuggestion ? (
                                <div className="polluxa-recommend-cell">
                                  <span className="polluxa-recommend-value">
                                    ${(c.dailyBudgetCents / 100).toFixed(0)} <span className="up">↗</span> ${(recommendedCents / 100).toFixed(0)}
                                  </span>
                                  <button
                                    type="button"
                                    className="polluxa-accept-btn"
                                    onClick={async () => {
                                      setAcceptedIds((prev) => new Set(prev).add(c.id));
                                      try {
                                        await api.updateCampaign(c.id, { dailyBudgetCents: recommendedCents });
                                        setCampaigns((prev) => prev.map((x) => x.id === c.id ? { ...x, dailyBudgetCents: recommendedCents } : x));
                                      } catch { /* already accepted in UI */ }
                                    }}
                                  >
                                    Accept
                                  </button>
                                  <button
                                    type="button"
                                    className="polluxa-reject-btn"
                                    aria-label="Dismiss suggestion"
                                    onClick={() => setDismissedIds((prev) => new Set(prev).add(c.id))}
                                  >
                                    👎
                                  </button>
                                </div>
                              ) : (
                                <span className="polluxa-recommend-empty">—</span>
                              )}
                            </td>
                            <td className="polluxa-reason-cell">
                              <span className={`polluxa-reason polluxa-reason-${bucket}`}>{reasonFor(c, globalIndex)}</span>
                            </td>
                          </tr>
                        );
                      })}
                      {pagedCampaigns.length === 0 && (
                        <tr>
                          <td colSpan={16}>
                            <div className="polluxa-table-empty">
                              <p>No campaigns match your filters.</p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </>
                )}

                {mode === "adsets" && (
                  <>
                    <thead>
                      <tr>
                        <th style={{ width: 40 }}>
                          <input
                            type="checkbox"
                            onChange={(e) => handleSelectAll(e.target.checked)}
                            checked={selectedIds.length === filteredAdSets.length && filteredAdSets.length > 0}
                          />
                        </th>
                        <th>Ad Set Name</th>
                        <th>Campaign</th>
                        <th>Status</th>
                        <th>Objective</th>
                        <th>Location</th>
                        <th>Placements</th>
                        <th>Bid Strategy</th>
                        <th>Budget/Day</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedAdSets.map((s) => {
                        const parent = campaignById[s.campaignId];
                        return (
                          <tr key={s.id}>
                            <td>
                              <input type="checkbox" checked={selectedIds.includes(s.id)} onChange={() => handleSelectRow(s.id)} />
                            </td>
                            <td>
                              <div className="polluxa-campaign-cell">
                                <strong>{s.name}</strong>
                                <span className="polluxa-campaign-id">({s.id})</span>
                              </div>
                            </td>
                            <td>{parent ? parent.name : <span className="polluxa-recommend-empty">—</span>}</td>
                            <td><StatusBadge status={s.status} /></td>
                            <td><span className="polluxa-pill goal">{adSetObjective(s)}</span></td>
                            <td><span className="polluxa-pill location">{adSetLocation(s)}</span></td>
                            <td>
                              {s.placements?.length
                                ? <span className="polluxa-pill">{s.placements.slice(0, 2).join(", ")}{s.placements.length > 2 ? ` +${s.placements.length - 2}` : ""}</span>
                                : <span className="polluxa-recommend-empty">Automatic</span>}
                            </td>
                            <td>{s.bidStrategy || "—"}</td>
                            <td>${(s.dailyBudgetCents / 100).toFixed(2)}</td>
                          </tr>
                        );
                      })}
                      {pagedAdSets.length === 0 && (
                        <tr>
                          <td colSpan={9}>
                            <div className="polluxa-table-empty">
                              <p>No ad sets yet. Ad sets you create for a campaign will appear here.</p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </>
                )}

                {mode === "ads" && (
                  <>
                    <thead>
                      <tr>
                        <th style={{ width: 40 }}>
                          <input
                            type="checkbox"
                            onChange={(e) => handleSelectAll(e.target.checked)}
                            checked={selectedIds.length === filteredAds.length && filteredAds.length > 0}
                          />
                        </th>
                        <th>Ad Name</th>
                        <th>Campaign</th>
                        <th>Ad Set</th>
                        <th>Status</th>
                        <th>Format</th>
                        <th>Headline</th>
                        <th>CTA</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedAds.map((a) => {
                        const parentSet = adSetById[a.adSetId];
                        const parentCampaign = parentSet ? campaignById[parentSet.campaignId] : undefined;
                        return (
                          <tr key={a.id}>
                            <td>
                              <input type="checkbox" checked={selectedIds.includes(a.id)} onChange={() => handleSelectRow(a.id)} />
                            </td>
                            <td>
                              <div className="polluxa-ad-name-cell">
                                {a.creative.imageUrl
                                  ? <img src={a.creative.imageUrl} alt="" className="polluxa-ad-thumb" />
                                  : <span className="polluxa-ad-thumb placeholder" aria-hidden>🖼</span>}
                                <strong>{a.name}</strong>
                              </div>
                            </td>
                            <td>{parentCampaign ? parentCampaign.name : <span className="polluxa-recommend-empty">—</span>}</td>
                            <td>{parentSet ? parentSet.name : <span className="polluxa-recommend-empty">—</span>}</td>
                            <td><StatusBadge status={a.status} /></td>
                            <td><span className="polluxa-pill">{a.format.replace(/_/g, " ")}</span></td>
                            <td className="polluxa-ad-headline">{a.creative.headline || "—"}</td>
                            <td>{a.creative.callToAction || "—"}</td>
                          </tr>
                        );
                      })}
                      {pagedAds.length === 0 && (
                        <tr>
                          <td colSpan={8}>
                            <div className="polluxa-table-empty">
                              <p>No ads yet. Ads you create within an ad set will appear here.</p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </>
                )}
              </table>
            </div>

            <div className="polluxa-pagination">
              <span>Total {totalItems} items</span>
              <div className="polluxa-pagination-controls">
                <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹</button>
                <span className="polluxa-page-box">{page}</span>
                <button disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>›</button>
              </div>
              <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                <option value={10}>10 / page</option>
                <option value={20}>20 / page</option>
                <option value={50}>50 / page</option>
              </select>
            </div>
          </Reveal>
        )}
      </div>
    </div>
  );
}
