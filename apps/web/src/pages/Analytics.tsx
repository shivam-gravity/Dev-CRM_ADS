import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  PieChart, Pie, Cell, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { api, AdInsightNetwork, AdInsightsResponse } from "../api/client.js";
import Reveal from "../components/Reveal.js";
import { MetaInfinityIcon, GoogleIcon, TikTokIcon, BingIcon } from "../components/icons.js";
import { formatMoneyMinor } from "../constants/money.js";
import { useCurrency } from "../providers/CurrencyProvider.js";

const AUDIENCE_COLORS = ["#7033f5", "#0e9f6e", "#f59e0b", "#ef4444", "#9ca3af"];
const PAGE_COLORS = ["#3b82f6", "#22d3ee", "#a5b4fc", "#c7d2fe"];

// Only Meta + Google are live; TikTok and Bing are shown as disabled "Coming soon" tabs.
const PLATFORM_TABS: { id: AdInsightNetwork; label: string; icon: JSX.Element; comingSoon?: boolean }[] = [
  { id: "meta", label: "Meta", icon: <MetaInfinityIcon /> },
  { id: "google", label: "Google", icon: <GoogleIcon /> },
  { id: "tiktok", label: "TikTok", icon: <TikTokIcon />, comingSoon: true },
  { id: "bing", label: "Bing", icon: <BingIcon />, comingSoon: true },
];

// Currency is passed in rather than hardcoded: these are AD SPEND figures, so they must render in
// the connected ad account's billing currency (see providers/CurrencyProvider).
function fmtMoney(cents: number, currency: string) {
  return formatMoneyMinor(cents, currency, { decimals: 0 });
}

function fmtNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtCpa(cents: number | null, currency: string) {
  if (cents == null) return "—";
  return formatMoneyMinor(cents, currency);
}

function truncate(s: string, max: number) {
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + "...";
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadInsightsCsv(network: AdInsightNetwork, data: AdInsightsResponse, currency: string) {
  const lines: string[] = [];
  lines.push("Section,Name,Metric 1,Value 1,Metric 2,Value 2,Campaigns");
  for (const a of data.audience.top) {
    lines.push([`Audience`, a.name, "CPA", fmtCpa(a.cpaCents, currency), "Spend", fmtMoney(a.spendCents, currency), a.campaignCount].map(csvCell).join(","));
  }
  for (const p of data.pages.top) {
    lines.push([`Page`, p.url, "CVR%", p.cvr, "Spend", fmtMoney(p.spendCents, currency), p.campaignCount].map(csvCell).join(","));
  }
  for (const ad of data.creative.topAds) {
    lines.push([`Creative`, ad.headline, "CTR%", ad.ctr, "CPA", fmtCpa(ad.cpaCents, currency), ad.campaignCount].map(csvCell).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ad-insights-${network}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Analytics({ businessId }: { businessId: string }) {
  const { currency } = useCurrency();
  const [network, setNetwork] = useState<AdInsightNetwork>("meta");
  const [data, setData] = useState<AdInsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh(n: AdInsightNetwork) {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getAdInsights(businessId, n);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load ad insights");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh(network);
  }, [businessId, network]);

  return (
    <div className="page-analytics">
      <div className="page-header">
        <div>
          <h1>Ad Insights</h1>
          <p className="subtitle">Performance breakdown by audience, landing page, and creative.</p>
        </div>
        <div className="flex gap-2 items-center">
          {data?.isDemo && <span className="pill demo-pill">Demo</span>}
          {data && !data.isDemo && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => downloadInsightsCsv(network, data, currency)}>
              Export CSV
            </button>
          )}
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="platform-tabs">
        {PLATFORM_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`platform-tab ${network === tab.id ? "active" : ""} ${tab.comingSoon ? "disabled" : ""}`}
            onClick={() => { if (!tab.comingSoon) setNetwork(tab.id); }}
            disabled={tab.comingSoon}
            title={tab.comingSoon ? "Coming soon" : undefined}
            style={tab.comingSoon ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
          >
            {tab.icon}
            {tab.label}{tab.comingSoon ? " — Coming soon" : ""}
          </button>
        ))}
      </div>

      {loading || !data ? (
        <div className="campaigns-loading">
          {[1, 2].map(i => <div key={i} className="campaign-row-skeleton" />)}
        </div>
      ) : (
        <Reveal>
          <div className="ai-insights-content">
            {data.isDemo && (
              <div className="demo-banner">
                <span>Demo data. Create your first campaign to view real performance.</span>
                <Link to="/campaigns/new" className="btn btn-primary btn-sm">Create campaign</Link>
              </div>
            )}

            {/* KPI Summary Row */}
            <div className="ai-kpi-row">
              <div className="ai-kpi-card">
                <span className="ai-kpi-label">Spend</span>
                <span className="ai-kpi-value">{fmtMoney(data.totals.spendCents, currency)}</span>
              </div>
              <div className="ai-kpi-card">
                <span className="ai-kpi-label">Impressions</span>
                <span className="ai-kpi-value">{fmtNum(data.totals.impressions)}</span>
              </div>
              <div className="ai-kpi-card">
                <span className="ai-kpi-label">Clicks</span>
                <span className="ai-kpi-value">{fmtNum(data.totals.clicks)}</span>
              </div>
              <div className="ai-kpi-card">
                <span className="ai-kpi-label">Conversions</span>
                <span className="ai-kpi-value">{fmtNum(data.totals.conversions)}</span>
              </div>
              <div className="ai-kpi-card">
                <span className="ai-kpi-label">CPA</span>
                <span className="ai-kpi-value">{fmtCpa(data.totals.cpaCents, currency)}</span>
              </div>
              <div className="ai-kpi-card">
                <span className="ai-kpi-label">ROAS</span>
                <span className="ai-kpi-value">{data.totals.roas != null ? `${data.totals.roas.toFixed(1)}x` : "—"}</span>
              </div>
            </div>

            {/* Audience + Page side by side */}
            <div className="ai-split-grid">
              {/* Audience */}
              <section className="ai-insight-card">
                <div className="ai-card-header">
                  <h2>Audience Performance</h2>
                </div>

                <div className="ai-donut-section">
                  <div className="ai-donut-wrap">
                    <ResponsiveContainer width="100%" height={160}>
                      <PieChart>
                        <Pie
                          data={data.audience.distribution.slice(0, 5)}
                          dataKey="sharePct"
                          nameKey="label"
                          innerRadius={48}
                          outerRadius={70}
                          paddingAngle={2}
                        >
                          {data.audience.distribution.slice(0, 5).map((_, i) => (
                            <Cell key={i} fill={AUDIENCE_COLORS[i % AUDIENCE_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(v: any) => `${v}%`} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="ai-legend">
                    {data.audience.distribution.slice(0, 5).map((slice, i) => (
                      <li key={slice.label}>
                        <span className="ai-legend-dot" style={{ background: AUDIENCE_COLORS[i % AUDIENCE_COLORS.length] }} />
                        <span className="ai-legend-label">{truncate(slice.label, 30)}</span>
                        <span className="ai-legend-pct">{slice.sharePct}%</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="ai-table">
                  <div className="ai-table-header">
                    <span className="ai-th-name">Audience</span>
                    <span className="ai-th">CPA</span>
                    <span className="ai-th">Spend</span>
                    <span className="ai-th">Campaigns</span>
                  </div>
                  {data.audience.top.map((a, i) => (
                    <div key={i} className="ai-table-row">
                      <span className="ai-td-name" title={a.name}>{truncate(a.name, 35)}</span>
                      <span className="ai-td">{fmtCpa(a.cpaCents, currency)}</span>
                      <span className="ai-td">{fmtMoney(a.spendCents, currency)}</span>
                      <span className="ai-td">{a.campaignCount}</span>
                    </div>
                  ))}
                </div>
              </section>

              {/* Pages */}
              <section className="ai-insight-card">
                <div className="ai-card-header">
                  <h2>Landing Page Performance</h2>
                </div>

                <div className="ai-donut-section">
                  <div className="ai-donut-wrap">
                    <ResponsiveContainer width="100%" height={160}>
                      <PieChart>
                        <Pie
                          data={data.pages.distribution.slice(0, 4)}
                          dataKey="sharePct"
                          nameKey="label"
                          innerRadius={48}
                          outerRadius={70}
                          paddingAngle={2}
                        >
                          {data.pages.distribution.slice(0, 4).map((_, i) => (
                            <Cell key={i} fill={PAGE_COLORS[i % PAGE_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(v: any) => `${v}%`} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="ai-legend">
                    {data.pages.distribution.slice(0, 4).map((slice, i) => (
                      <li key={slice.label}>
                        <span className="ai-legend-dot" style={{ background: PAGE_COLORS[i % PAGE_COLORS.length] }} />
                        <span className="ai-legend-label">{truncate(slice.label, 30)}</span>
                        <span className="ai-legend-pct">{slice.sharePct}%</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="ai-table">
                  <div className="ai-table-header">
                    <span className="ai-th-name">Page</span>
                    <span className="ai-th">CVR</span>
                    <span className="ai-th">Spend</span>
                    <span className="ai-th">Campaigns</span>
                  </div>
                  {data.pages.top.map((p, i) => (
                    <div key={i} className="ai-table-row">
                      <span className="ai-td-name" title={p.url}>{truncate(p.url, 35)}</span>
                      <span className="ai-td">{p.cvr}%</span>
                      <span className="ai-td">{fmtMoney(p.spendCents, currency)}</span>
                      <span className="ai-td">{p.campaignCount}</span>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            {/* Creative Section */}
            <section className="ai-insight-card">
              <div className="ai-card-header">
                <h2>Creative Performance</h2>
                <span className="ai-card-badge">{data.creative.scatter.length} creatives</span>
              </div>

              {/* CTR Bar Chart */}
              <div className="ai-ctr-chart">
                <h3 className="ai-sub-heading">Click-Through Rate Comparison</h3>
                <ResponsiveContainer width="100%" height={Math.max(180, data.creative.topAds.length * 60 + 40)}>
                  <BarChart
                    data={data.creative.topAds.map((ad, i) => ({
                      name: truncate(ad.headline, 28),
                      ctr: ad.ctr,
                      fill: i === 0 ? "#7033f5" : i === 1 ? "#0e9f6e" : "#f59e0b",
                    }))}
                    layout="vertical"
                    margin={{ top: 5, right: 30, left: 10, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                    <XAxis type="number" unit="%" tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="name" width={180} tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(v: any) => `${v}%`} />
                    <Bar dataKey="ctr" radius={[0, 6, 6, 0]} barSize={24}>
                      {data.creative.topAds.map((_, i) => (
                        <Cell key={i} fill={i === 0 ? "#7033f5" : i === 1 ? "#0e9f6e" : "#f59e0b"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Top Ads Grid */}
              <h3 className="ai-sub-heading">Top Performing Ads</h3>
              <div className="ai-ads-grid">
                {data.creative.topAds.map((ad, i) => (
                  <div key={ad.id} className="ai-ad-preview">
                    <div className="ai-ad-preview-header">
                      <span className="ai-ad-preview-rank" data-rank={i + 1}>#{i + 1}</span>
                      <div className="ai-ad-preview-kpis">
                        <div className="ai-ad-kpi">
                          <span className="ai-ad-kpi-value" style={{ color: "#0e9f6e" }}>{ad.ctr}%</span>
                          <span className="ai-ad-kpi-label">CTR</span>
                        </div>
                        <div className="ai-ad-kpi">
                          <span className="ai-ad-kpi-value">{fmtCpa(ad.cpaCents, currency)}</span>
                          <span className="ai-ad-kpi-label">CPA</span>
                        </div>
                      </div>
                    </div>
                    {ad.imageUrl && <img src={ad.imageUrl} alt="" className="ai-ad-preview-img" />}
                    <div className="ai-ad-preview-body">
                      <h4 className="ai-ad-preview-headline">{ad.headline}</h4>
                      <p className="ai-ad-preview-text">{ad.body}</p>
                    </div>
                    <div className="ai-ad-preview-footer">
                      <span>{ad.campaignCount} campaign{ad.campaignCount !== 1 ? "s" : ""}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </Reveal>
      )}
    </div>
  );
}
