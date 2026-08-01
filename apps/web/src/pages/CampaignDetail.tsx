import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { usePageHeader } from "../context/PageHeaderContext.js";
import { api, Campaign, LiveInsights, NormalizedPerformance, OptimizationDecision, TrendPoint } from "../api/client.js";
import StatusBadge, { NetworkBadge } from "../components/StatusBadge.js";
import SparkChart from "../components/SparkChart.js";
import Reveal from "../components/Reveal.js";
import { useRealtimeContext } from "../providers/RealtimeProvider.js";
import { formatMoneyMinor } from "../constants/money.js";
import { useCurrency } from "../providers/CurrencyProvider.js";
import { adRef, adSetRef, campaignRef, groupVariantsIntoAdSets } from "../lib/campaignRef.js";

const LIVE_INSIGHTS_POLL_MS = 30000;

export default function CampaignDetail() {
  const { currency, symbol, formatDaily } = useCurrency();
  const { campaignId } = useParams<{ campaignId: string }>();
  const { subscribe } = useRealtimeContext();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [performance, setPerformance] = useState<NormalizedPerformance[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [liveInsights, setLiveInsights] = useState<LiveInsights | null>(null);
  const [decisions, setDecisions] = useState<OptimizationDecision[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingBudget, setEditingBudget] = useState(false);
  const [newBudget, setNewBudget] = useState("");
  const pollHandle = useRef<ReturnType<typeof setInterval> | null>(null);

  usePageHeader({ breadcrumb: ["Campaigns", campaign?.name ?? "…"] });

  async function refresh() {
    if (!campaignId) return;
    const [camp, perf, trendData] = await Promise.all([
      api.getCampaign(campaignId),
      api.getPerformance(campaignId),
      api.getCampaignTrend(campaignId),
    ]);
    setCampaign(camp);
    setPerformance(perf);
    setTrend(trendData);
    setNewBudget(String(camp.dailyBudgetCents / 100));
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, [campaignId]);

  // Real-time insights: WebSocket push from metricsIngestionWorker triggers an instant
  // re-fetch instead of waiting for the next 30s poll tick.
  useEffect(() => {
    if (!campaignId || campaign?.status !== "active") return;
    const unsub = subscribe("insights.update", (_ch, payload: any) => {
      if (payload?.campaignId === campaignId) {
        api.getLiveInsights(campaignId).then(setLiveInsights).catch(() => {});
      }
    });
    return unsub;
  }, [campaignId, campaign?.status, subscribe]);

  // Live Insights Dashboard: poll as fallback (reduced frequency since WS handles most updates).
  useEffect(() => {
    if (!campaignId || campaign?.status !== "active") {
      setLiveInsights(null);
      return;
    }
    const poll = () => api.getLiveInsights(campaignId).then(setLiveInsights).catch(() => {});
    poll();
    pollHandle.current = setInterval(poll, LIVE_INSIGHTS_POLL_MS);
    return () => { if (pollHandle.current) clearInterval(pollHandle.current); };
  }, [campaignId, campaign?.status]);

  async function runIngest() {
    if (!campaignId) return;
    setBusy("ingest");
    setError(null);
    try {
      await api.ingestMetrics(campaignId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ingest failed");
    } finally {
      setBusy(null);
    }
  }

  async function runOptimize() {
    if (!campaignId) return;
    setBusy("optimize");
    setError(null);
    try {
      const result = await api.optimize(campaignId);
      setDecisions(result);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Optimization failed");
    } finally {
      setBusy(null);
    }
  }

  async function handlePauseVariant(variantId: string) {
    if (!campaignId) return;
    setBusy(`pause-${variantId}`);
    try {
      await api.pauseVariant(campaignId, variantId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pause failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleActivateVariant(variantId: string) {
    if (!campaignId) return;
    if (!confirm("Activate this ad? It will start spending your budget immediately.")) return;
    setBusy(`activate-${variantId}`);
    try {
      await api.activateVariant(campaignId, variantId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Activate failed");
    } finally {
      setBusy(null);
    }
  }

  // Re-publish a campaign whose launch failed. Safe to expose as a plain button: launchCampaign is
  // idempotent end-to-end — it reuses an existing Meta campaign container and ad set and skips any
  // variant that already carries an externalId, so only the failed variants are retried and nothing
  // is created twice. Without this, a failed launch was a dead end with no route forward in the UI.
  //
  // Pin the retry to the campaign's OWN workspace rather than the currently-selected one: the
  // reused container lives in that workspace's ad account, so retrying under another account's
  // credentials would try to hang ad sets off a container it cannot see.
  async function handleRetryPublish() {
    if (!campaignId || !campaign) return;
    if (!confirm("Retry publishing the failed ads? Already-published ads are left untouched, and new ads are created paused.")) return;
    setBusy("retry-publish");
    setError(null);
    try {
      await api.launchCampaign(campaignId, campaign.workspaceId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleSaveBudget() {
    if (!campaignId || !campaign) return;
    const cents = Math.round(parseFloat(newBudget) * 100);
    if (isNaN(cents) || cents <= 0) return;
    setBusy("save-budget");
    try {
      await api.updateCampaign(campaignId, { dailyBudgetCents: cents });
      setEditingBudget(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Budget update failed");
    } finally {
      setBusy(null);
    }
  }

  if (!campaign) {
    return (
      <div className="campaign-detail-loading">
        <div className="onboarding-spinner" />
        <p>Loading campaign…</p>
      </div>
    );
  }

  const totalSpend = performance.reduce((s, p) => s + p.spendCents, 0);
  const totalImpressions = performance.reduce((s, p) => s + p.impressions, 0);
  const totalReach = performance.reduce((s, p) => s + p.reach, 0);
  const totalClicks = performance.reduce((s, p) => s + p.clicks, 0);
  const totalConversions = performance.reduce((s, p) => s + p.conversions, 0);
  const overallCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  const overallCpa = totalConversions > 0 ? totalSpend / totalConversions : null;
  // liveInsights (from the scheduled worker's freshest pull) takes precedence once available;
  // fall back to locally-aggregated performance so the KPI row isn't empty on first paint.
  const displayReach = liveInsights?.reach ?? totalReach;
  const displayCpmCents = liveInsights?.cpmCents ?? (totalImpressions > 0 ? Math.round((totalSpend / totalImpressions) * 1000) : null);
  const displayRoas = liveInsights?.roas ?? (totalSpend > 0 && totalConversions > 0 ? (totalConversions * 5000) / totalSpend : null);

  const spendTrend = trend.map((t) => t.spendCents);
  const clicksTrend = trend.map((t) => t.clicks);

  // Grouped by the SAME rule launchMetaHierarchy uses, so the hierarchy shown is the hierarchy
  // published. Plain derivation rather than useMemo: it runs after an early return, where a hook
  // would break ordering, and grouping a handful of variants costs nothing.
  const adSets = groupVariantsIntoAdSets(campaign.variants);

  function fmtMoney(cents: number) {
    return formatMoneyMinor(cents, currency);
  }

  return (
    <div className="campaign-detail">
      {/* Hero */}
      <div className="campaign-detail-hero">
        <div>
          <h1>
            {campaignRef(campaign) && <span className="ref-chip ref-chip-campaign">{campaignRef(campaign)}</span>}
            {campaign.name}
          </h1>
          <div className="campaign-detail-meta">
            <StatusBadge status={campaign.status} />
            <div className="network-badges">
              {campaign.networks.map((n) => <NetworkBadge key={n} network={n} />)}
            </div>
            {editingBudget ? (
              <div className="budget-edit-row">
                <span className="muted-text">{symbol}</span>
                <input
                  type="number"
                  value={newBudget}
                  onChange={(e) => setNewBudget(e.target.value)}
                  className="budget-input"
                  min={1}
                />
                <span className="muted-text">/day</span>
                <button className="btn btn-sm btn-primary" onClick={handleSaveBudget} disabled={busy === "save-budget"}>
                  {busy === "save-budget" ? "Saving…" : "Save"}
                </button>
                <button className="btn btn-sm btn-secondary" onClick={() => setEditingBudget(false)}>Cancel</button>
              </div>
            ) : (
              <button className="budget-display" onClick={() => setEditingBudget(true)}>
                {formatDaily(campaign.dailyBudgetCents)} ✏️
              </button>
            )}
          </div>
        </div>
        <div className="campaign-detail-actions">
          {campaign.variants.some((v) => v.status === "failed") && (
            <button className="btn btn-primary" onClick={handleRetryPublish} disabled={busy !== null}>
              {busy === "retry-publish" ? "Publishing…" : "↻ Retry Publish"}
            </button>
          )}
          <button className="btn btn-primary" onClick={runIngest} disabled={busy !== null}>
            {busy === "ingest" ? "Pulling…" : "⬇ Pull Metrics"}
          </button>
          <button className="btn btn-secondary" onClick={runOptimize} disabled={busy !== null}>
            {busy === "optimize" ? "Optimizing…" : "⚡ Run Optimization"}
          </button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {/* Live Insights Dashboard KPI row — Reach/CPM/ROAS refresh via liveInsights polling
          while the campaign is active (see the poll effect above); the rest come from the
          performance table fetched once on load/refresh. */}
      <div className="campaign-kpi-row">
        <div className="campaign-kpi">
          <span className="campaign-kpi-label">Total Spend</span>
          <span className="campaign-kpi-value">{fmtMoney(totalSpend)}</span>
        </div>
        <div className="campaign-kpi">
          <span className="campaign-kpi-label">Impressions</span>
          <span className="campaign-kpi-value">{totalImpressions.toLocaleString()}</span>
        </div>
        <div className="campaign-kpi">
          <span className="campaign-kpi-label">Reach</span>
          <span className="campaign-kpi-value">{displayReach.toLocaleString()}</span>
        </div>
        <div className="campaign-kpi">
          <span className="campaign-kpi-label">Clicks</span>
          <span className="campaign-kpi-value">{totalClicks.toLocaleString()}</span>
        </div>
        <div className="campaign-kpi">
          <span className="campaign-kpi-label">CTR</span>
          <span className="campaign-kpi-value">{overallCtr.toFixed(2)}%</span>
        </div>
        <div className="campaign-kpi">
          <span className="campaign-kpi-label">CPM</span>
          <span className="campaign-kpi-value">{displayCpmCents !== null ? fmtMoney(displayCpmCents) : "—"}</span>
        </div>
        <div className="campaign-kpi">
          <span className="campaign-kpi-label">Conversions</span>
          <span className="campaign-kpi-value">{totalConversions}</span>
        </div>
        <div className="campaign-kpi">
          <span className="campaign-kpi-label">CPA</span>
          <span className="campaign-kpi-value">{overallCpa ? fmtMoney(overallCpa) : "—"}</span>
        </div>
        <div className="campaign-kpi">
          <span className="campaign-kpi-label">ROAS</span>
          <span className="campaign-kpi-value">{displayRoas !== null ? `${displayRoas.toFixed(2)}x` : "—"}</span>
        </div>
      </div>
      {liveInsights?.isLive && <p className="muted-text campaign-live-note"><span className="live-dot" /> Live — refreshing every 30s</p>}

      {/* Trend charts */}
      {trend.length > 1 && (
        <Reveal>
          <div className="trend-charts-grid">
            <section className="card trend-chart-card">
              <h3>Spend Trend</h3>
              <SparkChart data={spendTrend} width={400} height={80} color="var(--accent)" fill />
              <div className="trend-chart-labels">
                <span>{trend[0]?.date}</span>
                <span>{trend[trend.length - 1]?.date}</span>
              </div>
            </section>
            <section className="card trend-chart-card">
              <h3>Clicks Trend</h3>
              <SparkChart data={clicksTrend} width={400} height={80} color="var(--accent-2)" fill />
              <div className="trend-chart-labels">
                <span>{trend[0]?.date}</span>
                <span>{trend[trend.length - 1]?.date}</span>
              </div>
            </section>
          </div>
        </Reveal>
      )}

      {/* ── The real Meta/Google hierarchy ─────────────────────────────────────────────────────
          This used to be a flat "Variants" grid, which quietly misrepresented what publishing does:
          Meta creates a campaign, then one AD SET per audience, then the ads inside it. A user
          looking at a flat list could not tell how many ad sets they were about to create, which
          ads shared targeting and budget, or why two ads behaved identically — all of which are
          ad-set-level facts. Grouping here by the same rule the launcher uses (audienceName, in
          first-seen order) means what is on screen is what gets created. */}
      <Reveal>
        <section className="card">
          <h2>Ad sets &amp; ads</h2>
          <p className="muted-text campaign-hierarchy-hint">
            {adSets.length} ad {adSets.length === 1 ? "set" : "sets"} · {campaign.variants.length}{" "}
            {campaign.variants.length === 1 ? "ad" : "ads"} · one ad set is created per audience, and the ads inside it
            share its targeting and budget.
          </p>
          {adSets.map((group, groupIndex) => (
            <div key={group.audienceName} className="adset-group">
              <div className="adset-group-header">
                <div>
                  {adSetRef(campaign, groupIndex) && <span className="ref-chip">{adSetRef(campaign, groupIndex)}</span>}
                  <strong className="adset-audience">{group.audienceName}</strong>
                </div>
                <span className="muted-text">
                  {group.variants.length} {group.variants.length === 1 ? "ad" : "ads"}
                </span>
              </div>
          <div className="variants-grid">
            {group.variants.map((v, adIndex) => {
              const vPerf = performance.find((p) => p.variantId === v.id);
              return (
                <div key={v.id} className="variant-card">
                  <div className="variant-card-header">
                    {adRef(campaign, groupIndex, adIndex) && (
                      <span className="ref-chip ref-chip-ad">{adRef(campaign, groupIndex, adIndex)}</span>
                    )}
                    <NetworkBadge network={v.network} />
                    <StatusBadge status={v.status} />
                  </div>
                  <strong className="variant-headline">{v.creative.headline}</strong>
                  <p className="variant-body">{v.creative.body}</p>
                  <span className="pill">{v.creative.callToAction}</span>

                  {/* A "Failed" badge on its own is undiagnosable — the network's rejection message is
                      the only thing that says whether this is a dead token, a rejected creative or a
                      budget floor. The backend has always recorded it; this is where it becomes visible. */}
                  {v.status === "failed" && v.failureReason && (
                    <p className="variant-failure" role="alert">
                      <span className="variant-failure-label">Why it failed</span>
                      {v.failureReason}
                    </p>
                  )}

                  {vPerf && (
                    <div className="variant-perf">
                      <div className="variant-stat">
                        <span>Spend</span>
                        <strong>{fmtMoney(vPerf.spendCents)}</strong>
                      </div>
                      <div className="variant-stat">
                        <span>CTR</span>
                        <strong>{(vPerf.ctr * 100).toFixed(2)}%</strong>
                      </div>
                      <div className="variant-stat">
                        <span>Conv.</span>
                        <strong>{vPerf.conversions}</strong>
                      </div>
                      {vPerf.cpaCents && (
                        <div className="variant-stat">
                          <span>CPA</span>
                          <strong>{fmtMoney(vPerf.cpaCents)}</strong>
                        </div>
                      )}
                    </div>
                  )}

                  {v.status === "active" && (
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => handlePauseVariant(v.id)}
                      disabled={busy === `pause-${v.id}`}
                    >
                      {busy === `pause-${v.id}` ? "Pausing…" : "⏸ Pause"}
                    </button>
                  )}
                  {v.status === "paused" && (
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => handleActivateVariant(v.id)}
                      disabled={busy === `activate-${v.id}`}
                    >
                      {busy === `activate-${v.id}` ? "Activating…" : "▶ Activate"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
            </div>
          ))}
        </section>
      </Reveal>

      {/* Performance table */}
      {performance.length > 0 && (
        <Reveal>
          <section className="card">
            <h2>Performance by Variant</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Network</th>
                    <th>Impressions</th>
                    <th>Clicks</th>
                    <th>CTR</th>
                    <th>Conv.</th>
                    <th>Conv. Rate</th>
                    <th>CPA</th>
                    <th>Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {performance.map((p) => (
                    <tr key={p.variantId}>
                      <td>
                        <NetworkBadge network={p.network} />
                      </td>
                      <td>{p.impressions.toLocaleString()}</td>
                      <td>{p.clicks.toLocaleString()}</td>
                      <td>{(p.ctr * 100).toFixed(2)}%</td>
                      <td>{p.conversions}</td>
                      <td>{(p.conversionRate * 100).toFixed(2)}%</td>
                      <td>{p.cpaCents !== null ? fmtMoney(p.cpaCents) : "—"}</td>
                      <td>{fmtMoney(p.spendCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </Reveal>
      )}

      {/* Optimization decisions timeline */}
      {decisions.length > 0 && (
        <Reveal>
          <section className="card">
            <h2>⚡ Optimization Decisions</h2>
            <div className="decisions-timeline">
              {decisions.map((d, i) => (
                <div key={i} className={`decision-item decision-${d.action}`}>
                  <div className="decision-icon">
                    {d.action === "increase_budget" ? "⬆" : d.action === "decrease_budget" ? "⬇" : d.action === "pause" ? "⏸" : "⏸"}
                  </div>
                  <div className="decision-content">
                    <strong className="decision-action">{d.action.replace(/_/g, " ")}</strong>
                    <p className="decision-reason">{d.reason}</p>
                    <span className="decision-time">{new Date(d.decidedAt).toLocaleTimeString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </Reveal>
      )}
    </div>
  );
}
