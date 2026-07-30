import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, AnalyticsSummary, TrendPoint, Campaign } from "../api/client.js";
import StatusBadge from "../components/StatusBadge.js";
import { formatMoneyMinor, formatMoneyWhole } from "../constants/money.js";
import { useCurrency } from "../providers/CurrencyProvider.js";

interface DayTotals {
  impressions: number;
  clicks: number;
  spendCents: number;
}

const PERIODS: { label: string; days: number; apiPeriod: "week" | "month" | "all" }[] = [
  { label: "Today", days: 1, apiPeriod: "week" },
  { label: "Last 7 days", days: 7, apiPeriod: "week" },
  { label: "Last 14 days", days: 14, apiPeriod: "month" },
  { label: "Last 30 days", days: 30, apiPeriod: "month" },
  { label: "Last 90 days", days: 90, apiPeriod: "all" },
];

const METRICS = ["Spend", "CPM", "CPC", "CTR"] as const;
type MetricKey = (typeof METRICS)[number];

function dayValue(totals: DayTotals | undefined, metric: MetricKey): number {
  if (!totals) return 0;
  const spend = totals.spendCents / 100;
  switch (metric) {
    case "Spend":
      return spend;
    case "CPM":
      return totals.impressions > 0 ? spend / (totals.impressions / 1000) : 0;
    case "CPC":
      return totals.clicks > 0 ? spend / totals.clicks : 0;
    case "CTR":
      return totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
  }
}

// `value` is in WHOLE currency units here (callers already divided by 100), and the currency is
// the ad account's — never a hardcoded "$".
function formatMetric(value: number, metric: MetricKey, currency: string): string {
  if (metric === "CTR") return `${value.toFixed(2)}%`;
  return formatMoneyWhole(value, currency);
}

export default function Dashboard({ businessId }: { businessId: string }) {
  const { currency } = useCurrency();
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [totalsByDate, setTotalsByDate] = useState<Record<string, DayTotals>>({});
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [activePeriod, setActivePeriod] = useState(PERIODS[1].label);
  const [activeMetric, setActiveMetric] = useState<MetricKey>("Spend");

  const period = PERIODS.find((p) => p.label === activePeriod) ?? PERIODS[1];

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [, camps] = await Promise.all([api.getBusiness(businessId), api.listCampaigns(businessId)]);
        if (cancelled) return;
        setCampaigns(camps);

        const [summaryResult, trends] = await Promise.all([
          api.getAnalyticsSummary(businessId, period.apiPeriod),
          Promise.all(camps.map((c) => api.getCampaignTrend(c.id).catch<TrendPoint[]>(() => []))),
        ]);
        if (cancelled) return;

        const merged: Record<string, DayTotals> = {};
        for (const trend of trends) {
          for (const point of trend) {
            const existing = merged[point.date] ?? { impressions: 0, clicks: 0, spendCents: 0 };
            merged[point.date] = {
              impressions: existing.impressions + point.impressions,
              clicks: existing.clicks + point.clicks,
              spendCents: existing.spendCents + point.spendCents,
            };
          }
        }
        setSummary(summaryResult);
        setTotalsByDate(merged);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load dashboard data");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [businessId, period.apiPeriod]);

  // Oldest to newest for the chart, newest to oldest for the table
  const chartDates: string[] = [];
  for (let i = period.days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    chartDates.push(d.toISOString().split("T")[0]);
  }
  const tableDates = [...chartDates].reverse();

  const dateRangeStr = `${chartDates[0]}  →  ${chartDates[chartDates.length - 1]}`;

  const spend = (summary?.totalSpendCents ?? 0) / 100;
  const cpm = summary && summary.totalImpressions > 0 ? spend / (summary.totalImpressions / 1000) : 0;
  const cpc = summary?.avgCpc != null ? summary.avgCpc / 100 : 0;
  const ctr = summary ? summary.avgCtr * 100 : 0;

  const cardValues: Record<MetricKey, string> = {
    Spend: formatMoneyWhole(spend, currency),
    CPM: formatMoneyWhole(cpm, currency),
    CPC: formatMoneyWhole(cpc, currency),
    CTR: `${ctr.toFixed(2)}%`,
  };

  const chartValues = chartDates.map((d) => dayValue(totalsByDate[d], activeMetric));
  const maxValue = Math.max(...chartValues, 1);

  const pointCount = chartDates.length;
  const xFor = (idx: number) => (pointCount === 1 ? 490 : 100 + idx * (780 / (pointCount - 1)));
  const yFor = (value: number) => 200 - (value / maxValue) * 170;

  const linePoints = chartValues.map((v, idx) => `${xFor(idx)},${yFor(v)}`).join(" ");
  const areaPath = `M ${xFor(0)},200 ${chartValues
    .map((v, idx) => `L ${xFor(idx)},${yFor(v)}`)
    .join(" ")} L ${xFor(pointCount - 1)},200 Z`;

  // Only label a handful of x-axis ticks so dense ranges (30/90 days) stay readable
  const labelStep = Math.max(1, Math.ceil(pointCount / 6));
  const avgValue = chartValues.reduce((s, v) => s + v, 0) / (chartValues.length || 1);

  // The full management list lives at /campaigns (filterable, per-campaign perf, inline launch),
  // but it has no sidebar link — surface the newest few here with a "View all" jump-off, the way
  // an automation-first product keeps the campaign list one click from the home dashboard.
  const recentCampaigns = [...campaigns]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  return (
    <div className="polluxa-dashboard">

      {error && <p className="error" style={{ marginBottom: "20px" }}>{error}</p>}

      {/* Date Controls Row */}
      <div className="polluxa-controls-row">
        <div className="polluxa-date-pills">
          {PERIODS.map(({ label }) => (
            <button
              key={label}
              className={`polluxa-date-pill ${activePeriod === label ? "active" : ""}`}
              onClick={() => setActivePeriod(label)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="polluxa-datepicker-container">
          <input type="text" readOnly value={dateRangeStr} />
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        </div>
      </div>

      {/* Metric Cards Grid */}
      <div className="polluxa-metrics-grid">
        {METRICS.map((metric) => (
          <div
            key={metric}
            className={`polluxa-metric-card ${activeMetric === metric ? "active" : ""}`}
            onClick={() => setActiveMetric(metric)}
          >
            <div className="polluxa-metric-card-top">
              <span className={`metric-dot ${metric === "Spend" ? "purple" : "grey"}`}></span>
              <span>{metric}</span>
            </div>
            <div className="metric-checkbox">
              {activeMetric === metric && <span className="metric-checkbox-tick">✓</span>}
            </div>
            <div className="metric-value">{cardValues[metric]}</div>
          </div>
        ))}
      </div>

      {/* SVG Chart Card */}
      <div className="polluxa-chart-card">
        <svg width="100%" height="240" viewBox="0 0 1000 240" preserveAspectRatio="none">
          <defs>
            <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1c9ce0" stopOpacity="0.15" />
              <stop offset="100%" stopColor="#1c9ce0" stopOpacity="0" />
            </linearGradient>
          </defs>

          {[0, 1, 2, 3, 4, 5].map((idx) => (
            <line
              key={idx}
              x1="60"
              y1={30 + idx * 34}
              x2="940"
              y2={30 + idx * 34}
              stroke="#f3f4f6"
              strokeDasharray="4 4"
              strokeWidth="1"
            />
          ))}

          {[1, 0.8, 0.6, 0.4, 0.2, 0].map((frac, idx) => (
            <text
              key={frac}
              x="45"
              y={34 + idx * 34}
              fill="#9ca3af"
              fontSize="12"
              fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
              textAnchor="end"
            >
              {activeMetric === "CTR" ? `${(maxValue * frac).toFixed(1)}%` : formatMoneyWhole(maxValue * frac, currency, { decimals: 0 })}
            </text>
          ))}

          <line x1="60" y1="200" x2="940" y2="200" stroke="#e5e7eb" strokeWidth="1" />

          {chartDates.map((date, idx) =>
            idx % labelStep === 0 ? (
              <text
                key={date}
                x={xFor(idx)}
                y="222"
                fill="#9ca3af"
                fontSize="12"
                fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
                textAnchor="middle"
              >
                {date}
              </text>
            ) : null
          )}

          <polyline points={linePoints} fill="none" stroke="#1c9ce0" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <path d={areaPath} fill="url(#chartGrad)" />
        </svg>

        <div className="chart-avg-badge">
          Avg {activeMetric}: {formatMetric(avgValue, activeMetric, currency)}
        </div>
      </div>

      {/* Daily Performance Section */}
      <section className="polluxa-section">
        <div className="polluxa-section-header">
          <div className="polluxa-section-indicator"></div>
          <h2 className="polluxa-section-title">Daily Performance</h2>
        </div>

        <div className="polluxa-table-container">
          <table className="polluxa-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Spend</th>
                <th>Impressions</th>
                <th>CPM</th>
                <th>Clicks</th>
                <th>CPC</th>
                <th>CTR</th>
              </tr>
            </thead>
            <tbody>
              {tableDates.map((date) => {
                const totals = totalsByDate[date];
                const daySpend = (totals?.spendCents ?? 0) / 100;
                const impressions = totals?.impressions ?? 0;
                const clicks = totals?.clicks ?? 0;
                const dayCpm = impressions > 0 ? daySpend / (impressions / 1000) : 0;
                const dayCpc = clicks > 0 ? daySpend / clicks : 0;
                const dayCtr = impressions > 0 ? (clicks / impressions) * 100 : 0;
                return (
                  <tr key={date}>
                    <td style={{ fontWeight: 500, color: "#4b5563" }}>{date}</td>
                    <td>{formatMoneyWhole(daySpend, currency)}</td>
                    <td>{impressions}</td>
                    <td>{formatMoneyWhole(dayCpm, currency)}</td>
                    <td>{clicks}</td>
                    <td>{formatMoneyWhole(dayCpc, currency)}</td>
                    <td>{dayCtr.toFixed(2)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent Campaigns — jump-off to the full /campaigns management list (no sidebar link) */}
      <section className="polluxa-section">
        <div className="polluxa-section-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div className="polluxa-section-indicator"></div>
            <h2 className="polluxa-section-title">Recent Campaigns</h2>
          </div>
          <Link to="/campaigns" style={{ fontSize: "14px", fontWeight: 500, color: "var(--accent, #1c9ce0)", textDecoration: "none" }}>
            View all campaigns →
          </Link>
        </div>

        {recentCampaigns.length === 0 ? (
          <div style={{ padding: "24px", textAlign: "center", color: "#6b7280" }}>
            <p style={{ margin: "0 0 12px" }}>No campaigns yet.</p>
            <Link to="/campaigns/generator" className="btn btn-primary">Generate your first campaign</Link>
          </div>
        ) : (
          <div className="polluxa-table-container">
            <table className="polluxa-table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>Channels</th>
                  <th>Daily Budget</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {recentCampaigns.map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 500 }}>
                      <Link to={`/campaigns/${c.id}`} style={{ color: "var(--accent, #1c9ce0)", textDecoration: "none" }}>{c.name}</Link>
                    </td>
                    <td><StatusBadge status={c.status} /></td>
                    <td>{c.networks.map((n) => (n === "meta" ? "Meta" : "Google")).join(", ")}</td>
                    <td>{formatMoneyMinor(c.dailyBudgetCents, currency)}</td>
                    <td style={{ color: "#6b7280" }}>{new Date(c.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
