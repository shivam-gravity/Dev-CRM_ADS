import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, Campaign, NormalizedPerformance, AdStrategy } from "../api/client.js";
import StatusBadge from "../components/StatusBadge.js";
import Reveal from "../components/Reveal.js";
import { useCurrency } from "../providers/CurrencyProvider.js";

const STATUS_TABS = ["all", "active", "draft", "paused", "failed"] as const;
type StatusFilter = (typeof STATUS_TABS)[number];

interface CampaignRow extends Campaign {
  perf?: NormalizedPerformance[];
}

export default function Campaigns({ businessId }: { businessId: string }) {
  const { format, formatDaily } = useCurrency();
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [strategies, setStrategies] = useState<AdStrategy[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const navigate = useNavigate();

  async function refresh() {
    setLoading(true);
    const [camps, strats] = await Promise.all([
      api.listCampaigns(businessId),
      api.listStrategies(businessId),
    ]);
    setStrategies(strats);
    // load perf for each campaign
    const rows: CampaignRow[] = await Promise.all(
      camps.map(async (c) => {
        try {
          const perf = await api.getPerformance(c.id);
          return { ...c, perf };
        } catch {
          return c;
        }
      })
    );
    setCampaigns(rows);
    setLoading(false);
  }

  useEffect(() => {
    refresh().catch((err) => {
      setError(err.message);
      setLoading(false);
    });
  }, [businessId]);

  async function handleLaunch(campaign: Campaign) {
    setLaunching(campaign.id);
    setError(null);
    try {
      await api.launchCampaign(campaign.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Launch failed");
    } finally {
      setLaunching(null);
    }
  }

  async function handleDelete(campaign: Campaign) {
    if (!confirm(`Delete "${campaign.name}"? This can't be undone.`)) return;
    setDeleting(campaign.id);
    setError(null);
    try {
      await api.deleteCampaign(campaign.id);
      // Drop it from the list without a full refetch.
      setCampaigns((prev) => prev.filter((c) => c.id !== campaign.id));
    } catch (err) {
      // A launched (paused/active) campaign is refused by the backend (409) so its live Meta/Google
      // objects aren't orphaned — surface that message rather than a generic failure.
      setError(err instanceof Error ? err.message : "Failed to delete campaign");
    } finally {
      setDeleting(null);
    }
  }

  async function handleCreateFromStrategy() {
    const latestStrategy = strategies[0];
    if (!latestStrategy) {
      setError("No strategy found. Generate one from Dashboard first.");
      return;
    }
    setError(null);
    try {
      const campaign = await api.createCampaign({
        strategyId: latestStrategy.id,
        name: `Campaign — ${new Date().toLocaleDateString()}`,
        dailyBudgetCents: 3000,
      });
      navigate(`/campaigns/${campaign.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create campaign");
    }
  }

  const filtered = filter === "all" ? campaigns : campaigns.filter((c) => c.status === filter);

  function totalSpend(c: CampaignRow) {
    return (c.perf ?? []).reduce((s, p) => s + p.spendCents, 0);
  }
  function totalClicks(c: CampaignRow) {
    return (c.perf ?? []).reduce((s, p) => s + p.clicks, 0);
  }
  function totalConversions(c: CampaignRow) {
    return (c.perf ?? []).reduce((s, p) => s + p.conversions, 0);
  }
  function avgCtr(c: CampaignRow) {
    const impr = (c.perf ?? []).reduce((s, p) => s + p.impressions, 0);
    const clks = totalClicks(c);
    return impr > 0 ? (clks / impr) * 100 : 0;
  }

  return (
    <div className="page-campaigns">
      <div className="page-header">
        <div>
          <h1>Campaigns</h1>
          <p className="subtitle">Manage and monitor your ad campaigns across Meta &amp; Google.</p>
        </div>
        <button className="btn btn-primary" onClick={handleCreateFromStrategy}>
          + New Campaign
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {/* Status tabs */}
      <div className="status-tabs">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab}
            className={`status-tab ${filter === tab ? "active" : ""}`}
            onClick={() => setFilter(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
            <span className="status-tab-count">
              {tab === "all" ? campaigns.length : campaigns.filter((c) => c.status === tab).length}
            </span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="campaigns-loading">
          {[1, 2, 3].map((i) => (
            <div key={i} className="campaign-row-skeleton" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">📣</span>
          <p>No campaigns yet. Generate a strategy from the Dashboard, then create your first campaign.</p>
          <button className="btn btn-primary" onClick={handleCreateFromStrategy}>
            Create from Strategy
          </button>
        </div>
      ) : (
        <Reveal>
          <div className="campaigns-table-wrap">
            <table className="campaigns-table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Networks</th>
                  <th>Status</th>
                  <th>Daily Budget</th>
                  <th>Spend</th>
                  <th>CTR</th>
                  <th>Conversions</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="campaign-table-row">
                    <td>
                      <Link to={`/manager?campaign=${c.id}&mode=adsets`} className="campaign-table-name">
                        {c.name}
                      </Link>
                      <span className="campaign-table-date">
                        {new Date(c.createdAt).toLocaleDateString()}
                      </span>
                    </td>
                    <td>
                      <div className="network-badges">
                        {c.networks.map((n) => (
                          <span key={n} className={`network-badge network-badge-${n}`}>
                            {n === "meta" ? "Meta" : n === "google" ? "Google" : "TikTok"}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td>{formatDaily(c.dailyBudgetCents)}</td>
                    <td>{format(totalSpend(c))}</td>
                    <td>{avgCtr(c).toFixed(2)}%</td>
                    <td>{totalConversions(c)}</td>
                    <td>
                      <div className="campaign-table-actions">
                        <Link to={`/manager?campaign=${c.id}&mode=adsets`} className="btn btn-sm btn-secondary">
                          View
                        </Link>
                        {(c.status === "draft") && (
                          <>
                            <Link to={`/campaigns/${c.id}/builder`} className="btn btn-sm btn-secondary">
                              Edit
                            </Link>
                            <button
                              className="btn btn-sm btn-primary"
                              onClick={() => handleLaunch(c)}
                              disabled={launching === c.id}
                            >
                              {launching === c.id ? "Launching…" : "Launch"}
                            </button>
                          </>
                        )}
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => handleDelete(c)}
                          disabled={deleting === c.id}
                        >
                          {deleting === c.id ? "Deleting…" : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
      )}
    </div>
  );
}
