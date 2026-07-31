import { currentWorkspaceId } from "../lib/workspace.js";
import { useEffect, useMemo, useState } from "react";
import { api, Asset } from "../api/client.js";
import Reveal from "../components/Reveal.js";

const ITEM_TYPES = ["image", "video", "logo", "template"] as const;

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "chevron":
      return (
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <rect x="3" y="4.5" width="18" height="16" rx="2" />
          <line x1="3" y1="9.5" x2="21" y2="9.5" />
          <line x1="8" y1="2.5" x2="8" y2="6.5" />
          <line x1="16" y1="2.5" x2="16" y2="6.5" />
        </svg>
      );
    case "arrow-right":
      return (
        <svg {...common}>
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="13 6 19 12 13 18" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...common}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      );
    case "add":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <line x1="12" y1="8" x2="12" y2="16" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
      );
    default:
      return null;
  }
}

function EmptyCreativesIllustration() {
  return (
    <svg width="104" height="104" viewBox="0 0 104 104" fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="52" cy="86" rx="34" ry="7" fill="#111827" />
      <path
        d="M40 86c-10-4-16-13-16-23 0-15 12-27 27-27s27 12 27 27"
        stroke="#0f172a"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M46 74c-2-10 1-20 9-27 3-2.5 6.5-3.8 6.5-3.8"
        stroke="#0f172a"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M60 42.5l3-3.2c1-1 2.7-1 3.7.1 1 1 .9 2.6-.1 3.6l-3.1 3.1-3.5-3.6z"
        fill="#0f172a"
      />
      <circle cx="30" cy="30" r="2.4" fill="#c7c9d9" />
      <path
        d="M76 22l1.6 4 4 1.6-4 1.6-1.6 4-1.6-4-4-1.6 4-1.6z"
        fill="#7033f5"
      />
    </svg>
  );
}

export default function AssetLibrary({ businessId }: { businessId: string }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showUpload, setShowUpload] = useState(false);
  const [assetName, setAssetName] = useState("");
  const [assetUrl, setAssetUrl] = useState("");
  const [assetType, setAssetType] = useState<Asset["type"]>("image");
  const [assetTags, setAssetTags] = useState("");
  const [uploading, setUploading] = useState(false);

  const [uploadStart, setUploadStart] = useState("");
  const [uploadEnd, setUploadEnd] = useState("");
  const [itemFilter, setItemFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [searchText, setSearchText] = useState("");

  const wsId = currentWorkspaceId();

  async function loadAssets() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listAssets(wsId);
      setAssets(data);
    } catch {
      setError("Failed to fetch assets library.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAssets();
  }, [businessId]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!assetName.trim() || !assetUrl.trim()) return;

    setUploading(true);
    setError(null);
    try {
      await api.createAsset(wsId, {
        name: assetName,
        type: assetType,
        url: assetUrl,
        thumbnailUrl: assetUrl,
        size: 210000,
        mimeType: assetType === "video" ? "video/mp4" : "image/jpeg",
        tags: assetTags.split(",").map(t => t.trim()).filter(Boolean),
        width: 1080,
        height: 1080
      });
      setAssetName("");
      setAssetUrl("");
      setAssetTags("");
      setShowUpload(false);
      await loadAssets();
    } catch {
      setError("Failed to add creative to library.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this creative from library?")) return;
    try {
      await api.deleteAsset(id);
      await loadAssets();
    } catch {
      setError("Failed to delete creative.");
    }
  }

  const filteredAssets = useMemo(() => {
    return assets.filter(a => {
      if (searchText && !a.name.toLowerCase().includes(searchText.toLowerCase())) return false;
      if (itemFilter && a.type !== itemFilter) return false;
      if (uploadStart && a.createdAt < uploadStart) return false;
      if (uploadEnd && a.createdAt > `${uploadEnd}T23:59:59`) return false;
      if (sourceFilter === "ai" && !a.tags.includes("ai-generated")) return false;
      if (sourceFilter === "upload" && a.tags.includes("ai-generated")) return false;
      return true;
    });
  }, [assets, searchText, itemFilter, uploadStart, uploadEnd, sourceFilter]);

  function metaTag(tags: string[], prefix: string): string | null {
    const tag = tags.find(t => t.startsWith(prefix));
    return tag ? tag.slice(prefix.length) : null;
  }

  return (
    <div className="dap-page creative-lib-page">
      <div className="dap-breadcrumb">
        <span>Creative Hub</span>
        <Icon name="chevron" />
        <span className="dap-breadcrumb-current">Creative Library</span>
      </div>

      <div className="dap-tabs">
        <button type="button" className="dap-tab active">All Creatives</button>
      </div>

      <button className="btn btn-primary creative-lib-add-btn" onClick={() => setShowUpload(!showUpload)}>
        <Icon name="add" size={16} />
        {showUpload ? "Cancel" : "Add Creative"}
      </button>

      {error && <p className="error">{error}</p>}

      {showUpload && (
        <section className="card mb-4 creative-create-card">
          <h2>Add Creative</h2>
          <form onSubmit={handleUpload} className="creative-form mt-3">
            <label>
              Creative Name
              <input
                type="text"
                value={assetName}
                onChange={(e) => setAssetName(e.target.value)}
                placeholder="e.g. Summer Promo Square"
                required
              />
            </label>
            <label>
              Creative Image/Video URL
              <input
                type="url"
                value={assetUrl}
                onChange={(e) => setAssetUrl(e.target.value)}
                placeholder="e.g. https://unsplash.com/photo..."
                required
              />
            </label>
            <label>
              Item Type
              <select value={assetType} onChange={(e) => setAssetType(e.target.value as Asset["type"])}>
                <option value="image">Image</option>
                <option value="video">Video</option>
                <option value="logo">Logo</option>
                <option value="template">Template</option>
              </select>
            </label>
            <label>
              Tags (comma separated)
              <input
                type="text"
                value={assetTags}
                onChange={(e) => setAssetTags(e.target.value)}
                placeholder="e.g. promo, background"
              />
            </label>
            <button className="btn btn-primary" type="submit" disabled={uploading}>
              {uploading ? "Saving..." : "Save Creative"}
            </button>
          </form>
        </section>
      )}

      <div className="creative-lib-filters">
        <div className="creative-lib-filter">
          <span className="creative-lib-filter-label">Search</span>
          <input
            type="text"
            className="creative-lib-search-input"
            placeholder="Search by name…"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </div>

        <div className="creative-lib-filter">
          <span className="creative-lib-filter-label">Upload Date</span>
          <div className="creative-lib-date-range">
            <input type="date" value={uploadStart} onChange={(e) => setUploadStart(e.target.value)} aria-label="Upload date start" />
            <Icon name="arrow-right" size={14} />
            <input type="date" value={uploadEnd} onChange={(e) => setUploadEnd(e.target.value)} aria-label="Upload date end" />
            <Icon name="calendar" size={16} />
          </div>
        </div>

        <div className="creative-lib-filter">
          <span className="creative-lib-filter-label">Type</span>
          <div className="creative-lib-select">
            <select value={itemFilter} onChange={(e) => setItemFilter(e.target.value)}>
              <option value="">All types</option>
              {ITEM_TYPES.map(t => (
                <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
              ))}
            </select>
            <Icon name="chevron-down" size={16} />
          </div>
        </div>

        <div className="creative-lib-filter">
          <span className="creative-lib-filter-label">Source</span>
          <div className="creative-lib-select">
            <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
              <option value="">All sources</option>
              <option value="ai">AI-generated</option>
              <option value="upload">Uploaded</option>
            </select>
            <Icon name="chevron-down" size={16} />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="campaigns-loading">
          {[1, 2].map(i => <div key={i} className="creative-asset-skeleton" />)}
        </div>
      ) : filteredAssets.length === 0 ? (
        <div className="creative-lib-empty">
          <EmptyCreativesIllustration />
          <p>No creatives found. Add creative</p>
        </div>
      ) : (
        <Reveal>
          <div className="assets-grid-layout mt-3">
            {filteredAssets.map((asset) => (
              <div key={asset.id} className="asset-grid-card">
                <div className="asset-grid-preview">
                  {asset.type === "video" ? (
                    <div className="video-asset-mock">
                      <span>Video</span>
                    </div>
                  ) : (
                    <img src={asset.url} alt={asset.name} />
                  )}
                  <button className="delete-asset-btn" onClick={() => handleDelete(asset.id)}>×</button>
                </div>
                <div className="asset-grid-info">
                  <strong>{asset.name}</strong>
                  <span className="asset-format-badge format-text">{asset.type}</span>
                  {(metaTag(asset.tags, "aspect:") || metaTag(asset.tags, "lang:")) && (
                    <div className="asset-meta-row mt-1">
                      {metaTag(asset.tags, "aspect:") && <span className="creative-tag creative-tag-meta">{metaTag(asset.tags, "aspect:")}</span>}
                      {metaTag(asset.tags, "lang:") && metaTag(asset.tags, "lang:") !== "English" && (
                        <span className="creative-tag creative-tag-meta">{metaTag(asset.tags, "lang:")}</span>
                      )}
                    </div>
                  )}
                  <div className="asset-tags-row mt-2">
                    {asset.tags.filter(t => !t.startsWith("aspect:") && !t.startsWith("lang:")).map(t => <span key={t} className="creative-tag">{t}</span>)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Reveal>
      )}
    </div>
  );
}
