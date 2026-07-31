import { campaignPathById } from "../lib/campaignRef.js";
import { currentWorkspaceId } from "../lib/workspace.js";
import { Fragment, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Draft } from "../api/client.js";
import { formatMoneyMinor, formatMoneyWhole } from "../constants/money.js";
import { useCurrency } from "../providers/CurrencyProvider.js";


interface DraftVariant { network?: string; audienceName?: string }

/** Draft.data is duck-typed per producer — the CampaignBuilder save-draft flow writes
 * dailyBudgetCents/variants/creativeAssets, while older demo-seeded drafts used a
 * looser {budget, platforms, targeting} shape. These helpers read whichever fields
 * are actually present instead of assuming one shape. */
function draftNetworks(data: Record<string, unknown>): string[] {
  const variants = Array.isArray(data.variants) ? (data.variants as DraftVariant[]) : [];
  if (variants.length) return [...new Set(variants.map((v) => v.network).filter((n): n is string => Boolean(n)))];
  if (Array.isArray(data.platforms)) return data.platforms as string[];
  return ["meta"];
}

function draftBudget(data: Record<string, unknown>, currency: string): string {
  // dailyBudgetCents is MINOR units; dailyBudget/budget are legacy WHOLE-unit fields kept for
  // older drafts — hence the two different formatters rather than one.
  if (typeof data.dailyBudgetCents === "number") return formatMoneyMinor(data.dailyBudgetCents, currency);
  if (typeof data.dailyBudget === "number") return formatMoneyWhole(data.dailyBudget, currency);
  if (typeof data.budget === "number") return formatMoneyWhole(data.budget, currency);
  return "—";
}

function draftAudience(data: Record<string, unknown>): string {
  const variants = Array.isArray(data.variants) ? (data.variants as DraftVariant[]) : [];
  const names = [...new Set(variants.map((v) => v.audienceName).filter((n): n is string => Boolean(n)))];
  if (names.length === 1) return names[0];
  if (names.length > 1) return `${names[0]} +${names.length - 1} more`;
  if (typeof data.audience === "string") return data.audience;
  return "—";
}

function draftCreativeCount(data: Record<string, unknown>): number | "—" {
  if (Array.isArray(data.creativeAssets) && data.creativeAssets.length) return data.creativeAssets.length;
  if (Array.isArray(data.variants) && data.variants.length) return data.variants.length;
  if (Array.isArray(data.creatives) && data.creatives.length) return data.creatives.length;
  return "—";
}

function draftProduct(data: Record<string, unknown>, fallbackName: string): string {
  if (typeof data.product === "string") return data.product;
  if (typeof data.finalUrl === "string") return data.finalUrl;
  if (typeof data.goal === "string") return data.goal;
  return fallbackName;
}



function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "chevron":
      return (
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      );
    case "meta":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
          <path d="M6.5 3C3.5 3 1 7 1 11.5S3.2 21 6 21c2 0 3.3-1.6 5-4.4 1.7 2.8 3 4.4 5 4.4 2.8 0 5-5 5-9.5S20.5 3 17.5 3c-2 0-3.4 1.7-5.5 5-2.1-3.3-3.5-5-5.5-5zm0 2.4c1 0 2 1.1 3.6 3.7-1.7 2.8-2.7 4.5-3.6 4.5-1.3 0-2.3-2.9-2.3-6.1 0-1.6.5-2.1 2.3-2.1zm11 0c1.8 0 2.3.5 2.3 2.1 0 3.2-1 6.1-2.3 6.1-.9 0-1.9-1.7-3.6-4.5 1.6-2.6 2.6-3.7 3.6-3.7z" />
        </svg>
      );
    case "google":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24">
          <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4c-.2 1.2-1 2.3-2.1 3v2.5h3.4c2-1.8 3.1-4.5 3.1-7.4z" />
          <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.7-2.4l-3.4-2.5c-.9.6-2 1-3.3 1-2.5 0-4.7-1.7-5.5-4H3.6v2.6C5.3 20 8.4 22 12 22z" />
          <path fill="#FBBC05" d="M6.5 14.1c-.2-.6-.3-1.4-.3-2.1s.1-1.5.3-2.1V7.3H3.6C3 8.7 2.7 10.3 2.7 12s.3 3.3 1 4.7z" />
          <path fill="#EA4335" d="M12 6.6c1.5 0 2.8.5 3.8 1.5l2.9-2.9C16.9 3.5 14.6 2.5 12 2.5c-3.6 0-6.7 2-8.4 5l3.4 2.6c.7-2.3 3-3.5 5.5-3.5z" />
        </svg>
      );
    case "tiktok":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
          <path d="M16 3c.6 2.2 2.2 3.7 4.5 3.9v3c-1.6 0-3-.5-4.2-1.4v6.4a5.4 5.4 0 1 1-4.7-5.4v3.1a2.4 2.4 0 1 0 1.7 2.3V3H16z" />
        </svg>
      );
    case "bing":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
          <path d="M5 2v16.2l4.3 2.4L19 15V11l-8-3v9.4l-2.4-1.4V2H5z" />
        </svg>
      );
    case "diamond":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 3h12l4 6-10 12L2 9l4-6z" />
        </svg>
      );
    case "send":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
          <path d="M2 21l21-9L2 3v7l15 2-15 2v7z" />
        </svg>
      );
    case "infinity":
      return (
        <svg {...common}>
          <path d="M18.6 8.4a4.8 4.8 0 1 0 0 7.2A6.5 6.5 0 0 1 12 12a6.5 6.5 0 0 1-6.6 3.6 4.8 4.8 0 1 1 0-7.2A6.5 6.5 0 0 1 12 12a6.5 6.5 0 0 1 6.6-3.6z" />
        </svg>
      );
    case "cart":
      return (
        <svg {...common}>
          <circle cx="9" cy="21" r="1" />
          <circle cx="20" cy="21" r="1" />
          <path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" />
        </svg>
      );
    case "cursor":
      return (
        <svg {...common}>
          <path d="M4 4l7.1 16.7 2-7 7-2z" />
        </svg>
      );
    case "target":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <circle cx="12" cy="12" r="1" />
        </svg>
      );
    case "palette":
      return (
        <svg {...common}>
          <path d="M12 22a10 10 0 1 1 10-10c0 2-1.5 3-3.5 3H15a2 2 0 0 0-1.5 3.3c.4.5.1 1.3-.5 1.6-.3.1-.7.1-1 .1z" />
          <circle cx="7.5" cy="10.5" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="11" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="16" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "type":
      return (
        <svg {...common}>
          <polyline points="4 7 4 4 20 4 20 7" />
          <line x1="9" y1="20" x2="15" y2="20" />
          <line x1="12" y1="4" x2="12" y2="20" />
        </svg>
      );
    case "cake":
      return (
        <svg {...common}>
          <line x1="12" y1="2" x2="12" y2="6" />
          <path d="M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" />
          <path d="M3 12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0 3 3 3 3 0 0 0 3-3c0-2-2-4-2-4H5s-2 2-2 4z" />
        </svg>
      );
    case "users":
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.9" />
          <path d="M16 3.1a4 4 0 0 1 0 7.8" />
        </svg>
      );
    case "pin":
      return (
        <svg {...common}>
          <path d="M12 22s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z" />
          <circle cx="12" cy="10" r="2.5" />
        </svg>
      );
    case "info":
      return (
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <line x1="12" y1="10" x2="12" y2="16" />
          <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      );
    case "inbox":
      return (
        <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 12h-6l-2 3h-4l-2-3H2" />
          <path d="M5.5 5h13l3.5 7v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7l3.5-7z" />
        </svg>
      );
    default:
      return null;
  }
}

interface DraftVariantFull {
  id?: string;
  network?: string;
  status?: string;
  audienceName?: string;
  landingPageUrl?: string;
  creative?: {
    headline?: string;
    body?: string;
    callToAction?: string;
    imageUrl?: string;
    videoUrl?: string;
    headlines?: string[];
    primaryTexts?: string[];
  };
}

interface DraftCreativeAsset {
  id?: string;
  url?: string;
  type?: string;
  source?: string;
}

function DraftCampaignDetail({ data }: { data: Record<string, unknown> }) {
  const { currency } = useCurrency();
  const variants = Array.isArray(data.variants) ? (data.variants as DraftVariantFull[]) : [];
  const creativeAssets = Array.isArray(data.creativeAssets) ? (data.creativeAssets as DraftCreativeAsset[]) : [];
  const locations = Array.isArray(data.locations) ? (data.locations as string[]) : [];
  const networks = Array.isArray(data.networks) ? (data.networks as string[]) : draftNetworks(data);

  return (
    <div className="dap-detail">
      <div className="dap-detail-grid">
        {/* Campaign Settings */}
        <div className="dap-detail-section">
          <h4>Campaign Settings</h4>
          <dl className="dap-detail-dl">
            {!!data.name && <><dt>Name</dt><dd>{String(data.name)}</dd></>}
            {!!data.dailyBudgetCents && <><dt>Daily Budget</dt><dd>{formatMoneyMinor(Number(data.dailyBudgetCents), currency)}</dd></>}
            {!!data.conversionEvent && <><dt>Conversion Event</dt><dd>{String(data.conversionEvent)}</dd></>}
            {!!data.finalUrl && <><dt>Final URL</dt><dd>{String(data.finalUrl)}</dd></>}
            {!!data.startDate && <><dt>Start Date</dt><dd>{String(data.startDate)}</dd></>}
            <dt>Networks</dt><dd>{networks.join(", ") || "—"}</dd>
            {locations.length > 0 && <><dt>Locations</dt><dd>{locations.join(", ")}</dd></>}
            {!!data.advantagePlus && <><dt>Advantage+</dt><dd>Enabled</dd></>}
          </dl>
        </div>

        {/* Ad Account Settings */}
        {!!(data.metaAdAccountId || data.pageId || data.googleCustomerId) && (
          <div className="dap-detail-section">
            <h4>Ad Account</h4>
            <dl className="dap-detail-dl">
              {!!data.metaAdAccountId && <><dt>Meta Ad Account</dt><dd>{String(data.metaAdAccountId)}</dd></>}
              {!!data.pageId && <><dt>Page ID</dt><dd>{String(data.pageId)}</dd></>}
              {!!data.instagramAccountId && <><dt>Instagram Account</dt><dd>{String(data.instagramAccountId)}</dd></>}
              {!!data.pixelId && <><dt>Pixel ID</dt><dd>{String(data.pixelId)}</dd></>}
              {!!data.googleCustomerId && <><dt>Google Customer</dt><dd>{String(data.googleCustomerId)}</dd></>}
              {!!data.googleConversionActionId && <><dt>Google Conv. Action</dt><dd>{String(data.googleConversionActionId)}</dd></>}
            </dl>
          </div>
        )}
      </div>

      {/* Creative Assets */}
      {creativeAssets.length > 0 && (
        <div className="dap-detail-section">
          <h4>Creative Assets ({creativeAssets.length})</h4>
          <div className="dap-detail-assets">
            {creativeAssets.map((a, idx) => (
              <div key={a.id ?? idx} className="dap-detail-asset">
                {a.type === "image" && a.url && <img src={a.url} alt={`Asset ${idx + 1}`} />}
                {a.type === "video" && a.url && <video src={a.url} controls />}
                <span className="dap-detail-asset-badge">{a.source ?? "upload"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ad Variants */}
      {variants.length > 0 && (
        <div className="dap-detail-section">
          <h4>Ad Variants ({variants.length})</h4>
          <div className="dap-detail-variants">
            {variants.map((v, idx) => {
              const c = v.creative;
              const headlines = c?.headlines?.length ? c.headlines : c?.headline ? [c.headline] : [];
              const primaryTexts = c?.primaryTexts?.length ? c.primaryTexts : c?.body ? [c.body] : [];
              return (
                <div key={v.id ?? idx} className="dap-detail-variant-card">
                  <div className="dap-detail-variant-header">
                    <span className="dap-detail-variant-network">{v.network ?? "meta"}</span>
                    <span className="dap-detail-variant-status">{v.status ?? "draft"}</span>
                    {v.audienceName && <span className="dap-detail-variant-audience">{v.audienceName}</span>}
                  </div>
                  {headlines.length > 0 && (
                    <div className="dap-detail-variant-field">
                      <strong>Headlines</strong>
                      <ul>{headlines.map((h, hi) => <li key={hi}>{h || <em className="muted-text">empty</em>}</li>)}</ul>
                    </div>
                  )}
                  {primaryTexts.length > 0 && (
                    <div className="dap-detail-variant-field">
                      <strong>Primary Text</strong>
                      <ul>{primaryTexts.map((t, ti) => <li key={ti}>{t || <em className="muted-text">empty</em>}</li>)}</ul>
                    </div>
                  )}
                  {c?.callToAction && (
                    <div className="dap-detail-variant-field">
                      <strong>CTA</strong>
                      <span>{c.callToAction}</span>
                    </div>
                  )}
                  {v.landingPageUrl && (
                    <div className="dap-detail-variant-field">
                      <strong>Landing Page</strong>
                      <span>{v.landingPageUrl}</span>
                    </div>
                  )}
                  {c?.imageUrl && (
                    <div className="dap-detail-variant-field">
                      <img src={c.imageUrl} alt="Ad creative" className="dap-detail-variant-img" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Drafts({ businessId }: { businessId: string }) {
  const { currency } = useCurrency();
  const navigate = useNavigate();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoPublish, setAutoPublish] = useState(() => localStorage.getItem("polluxa_auto_publish") === "1");
  const [expandedDraftId, setExpandedDraftId] = useState<string | null>(null);

  const wsId = currentWorkspaceId();

  async function loadDrafts() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listDrafts(wsId);
      setDrafts(data);
    } catch (err) {
      setError("Failed to fetch campaign drafts.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDrafts();
  }, [businessId]);

  function toggleAutoPublish() {
    setAutoPublish(prev => {
      const next = !prev;
      localStorage.setItem("polluxa_auto_publish", next ? "1" : "0");
      return next;
    });
  }

  async function handlePublish(draft: Draft) {
    setError(null);
    try {
      if (draft.origin === "campaign") {
        // A draft-status Campaign (Generator flow) — publishing means launching the real
        // Meta/Google hierarchy (all PAUSED), not flipping a Draft-table row's status.
        const campaignId = (draft.data as Record<string, unknown>)?.campaignId as string | undefined;
        if (!campaignId) { setError("This campaign draft has no linked campaign id."); return; }
        await api.launchCampaign(campaignId, wsId);
        // Launched campaigns leave the "draft" set, so drop it from the unpublished list.
        setDrafts(prev => prev.filter(d => d.id !== draft.id));
      } else {
        await api.publishDraft(draft.id);
        setDrafts(prev => prev.map(d => (d.id === draft.id ? { ...d, status: "published" } : d)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to publish draft.");
    }
  }

  async function handleDelete(draft: Draft) {
    if (!confirm("Are you sure you want to delete this draft?")) return;
    setError(null);
    try {
      if (draft.origin === "campaign") {
        // A draft-status Campaign lives in the Campaign table — delete it there. The backend
        // refuses (409) if it was ever launched, so live/paused Meta/Google objects aren't orphaned.
        const campaignId = (draft.data as Record<string, unknown>)?.campaignId as string | undefined;
        if (!campaignId) { setError("This campaign draft has no linked campaign id."); return; }
        await api.deleteCampaign(campaignId);
      } else {
        await api.deleteDraft(draft.id);
      }
      setDrafts(prev => prev.filter(d => d.id !== draft.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete draft.");
    }
  }

  async function handleEdit(draft: Draft) {
    const data = (draft.data ?? {}) as Record<string, unknown>;
    const campaignId = data.campaignId as string | undefined;
    if (campaignId) {
      navigate(await campaignPathById(campaignId, api.getCampaign, "/builder"));
    } else {
      setError("This draft has no linked campaign to edit.");
    }
  }

  const unpublished = drafts.filter(d => d.status !== "published");
  const recommendationsCount = drafts.filter(d => d.score !== undefined && d.status !== "published").length;
  const publishedCount = drafts.filter(d => d.status === "published").length;

  return (
    <div className="dap-page">
      <div className="dap-breadcrumb">
        <span>AI Optimize</span>
        <Icon name="chevron" />
        <span className="dap-breadcrumb-current">Draft &amp; AI Recs</span>
      </div>

      <div className="dap-tabs">
        <button type="button" className="dap-tab active">
          All Platforms
        </button>
      </div>

      <div className="dap-rec-card">
        <div className="dap-rec-top">
          <div>
            <h2>Recommended Ads</h2>
            <p className="dap-rec-sub">
              <strong>Top campaigns</strong> recommended. Select one to view structure.
            </p>
          </div>

          <div className="dap-rec-stats">
            <div className="dap-stat">
              <span className="dap-stat-icon dap-stat-icon-blue">
                <Icon name="diamond" size={18} />
              </span>
              <div>
                <span className="dap-stat-label">Recommendations</span>
                <strong className="dap-stat-val">{recommendationsCount}</strong>
              </div>
            </div>

            <div className="dap-divider" />

            <div className="dap-stat">
              <span className="dap-stat-icon dap-stat-icon-green">
                <Icon name="send" size={16} />
              </span>
              <div>
                <span className="dap-stat-label">Published</span>
                <strong className="dap-stat-val">{publishedCount}</strong>
              </div>
            </div>

            <button type="button" className="dap-toggle-btn" onClick={toggleAutoPublish}>
              <Icon name="infinity" size={16} />
              <span>Auto-Publish</span>
              <span className={`dap-toggle-pill ${autoPublish ? "active" : ""}`}>{autoPublish ? "Active" : "Paused"}</span>
            </button>
          </div>
        </div>

        <div className="dap-icon-grid-wrap">
          <p className="dap-info-text">
            AI recommendations appear <strong>24 hours</strong> after your first campaign is published, based on real performance data.
            {autoPublish && <> Auto-publish is <strong>active</strong> — top drafts will launch automatically.</>}
          </p>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="dap-drafts-section">
        <h2 className="dap-drafts-title">Unpublished Drafts</h2>

        <div className="dap-table-card">
          <div className="dap-table-wrap">
            <table className="dap-table">
              <thead>
                <tr>
                  <th>
                    Queues <span className="dap-th-info"><Icon name="info" /></span>
                  </th>
                  <th>Campaign</th>
                  <th>Daily budget</th>
                  <th>Audience</th>
                  <th>Creatives</th>
                  <th>Product</th>
                  <th>Update time</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={8} className="dap-table-loading">Loading…</td>
                  </tr>
                ) : unpublished.length === 0 ? (
                  <tr>
                    <td colSpan={8}>
                      <div className="dap-empty">
                        <Icon name="inbox" size={40} />
                        <span>No data</span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  unpublished.map((d, i) => {
                    const data = (d.data ?? {}) as Record<string, unknown>;
                    const isExpanded = expandedDraftId === d.id;
                    return (
                      <Fragment key={d.id}>
                        <tr className={`dap-row-clickable ${isExpanded ? "dap-row-expanded" : ""}`} onClick={() => setExpandedDraftId(isExpanded ? null : d.id)}>
                          <td>{i + 1}</td>
                          <td>{d.name}</td>
                          <td>{draftBudget(data, currency)}</td>
                          <td>{draftAudience(data)}</td>
                          <td>{draftCreativeCount(data)}</td>
                          <td>{draftProduct(data, d.name)}</td>
                          <td>{new Date(d.updatedAt).toLocaleString()}</td>
                          <td className="dap-row-actions" onClick={(e) => e.stopPropagation()}>
                            <button type="button" className="dap-row-btn" onClick={() => handleEdit(d)}>Edit</button>
                            <button type="button" className="dap-row-btn" onClick={() => handlePublish(d)}>Publish</button>
                            <button type="button" className="dap-row-btn dap-row-btn-danger" onClick={() => handleDelete(d)}>Delete</button>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="dap-expanded-row">
                            <td colSpan={8}>
                              <DraftCampaignDetail data={data} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

    </div>
  );
}
