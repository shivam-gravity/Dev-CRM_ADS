import { campaignPathById } from "../lib/campaignRef.js";
import { currentWorkspaceId } from "../lib/workspace.js";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, CatalogSourceResult, Draft, ProductAnalysis, ProductCatalogItem } from "../api/client.js";
import {
  ClockIcon as HistoryIcon,
  LinkIcon,
  PlusIcon,
  ShoppingBagIcon,
  CubeIcon,
  FacebookIcon,
  GoogleGmcIcon,
  XIcon,
  SearchIcon,
} from "../components/icons.js";
import { ACTIVE_PLATFORM_VALUES, CATALOG_COMING_SOON_LABEL } from "../constants/platforms.js";
import { useCurrency } from "../providers/CurrencyProvider.js";

const PRODUCT_SOURCE_TABS: { value: "all" | "shopify" | "facebook" | "google"; label: string; icon: React.ReactNode }[] = [
  { value: "all", label: "All", icon: <CubeIcon /> },
  { value: "shopify", label: "Shopify", icon: <ShoppingBagIcon /> },
  { value: "facebook", label: "Facebook feeds", icon: <FacebookIcon /> },
  { value: "google", label: "Google GMC", icon: <GoogleGmcIcon /> },
];

interface PromotedProduct {
  id: string;
  url?: string;
  name: string;
  category: string;
  summary: string;
}

export default function CampaignGenerator({ businessId }: { businessId: string }) {
  const navigate = useNavigate();
  // Catalog prices carry no per-item currency — see the note in Products.tsx.
  const { format: formatMoney } = useCurrency();
  const workspaceId = currentWorkspaceId();

  // The Promotion Objective review card moved to the Deep Research flow
  // (components/PromotionObjectiveCard.tsx). These values still parameterize this page's own
  // generate call, using the same defaults the card used to show; the pipeline derives the real
  // objective/business type from the crawled site regardless.
  const [countries] = useState<string[]>(["US"]);
  const [channels] = useState<string[]>([...ACTIVE_PLATFORM_VALUES]);
  const [objective] = useState<string[]>(["sales"]);

  const [productUrl, setProductUrl] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [products, setProducts] = useState<PromotedProduct[]>([]);

  const [historicalOpen, setHistoricalOpen] = useState(false);
  const [historicalDrafts, setHistoricalDrafts] = useState<Draft[] | null>(null);
  const [historicalLoading, setHistoricalLoading] = useState(false);

  const [productsModalOpen, setProductsModalOpen] = useState(false);
  const [productsModalTab, setProductsModalTab] = useState<"all" | "shopify" | "facebook" | "google">("all");
  const [productSearch, setProductSearch] = useState("");
  const [catalog, setCatalog] = useState<CatalogSourceResult[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [dailyBudget, setDailyBudget] = useState("50");
  const [generating, setGenerating] = useState(false);
  const [generationStage, setGenerationStage] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

  useEffect(() => {
    const deepResearchRaw = sessionStorage.getItem("polluxa_deep_research");
    if (deepResearchRaw) {
      sessionStorage.removeItem("polluxa_deep_research");
      try {
        const parsed = JSON.parse(deepResearchRaw) as {
          url: string;
          product: ProductAnalysis;
        };
        setProducts((prev) => [
          ...prev,
          {
            id: `url-${prev.length}-${Date.now()}`,
            url: parsed.url,
            name: parsed.product.productName,
            category: parsed.product.category,
            summary: parsed.product.summary,
          },
        ]);
      } catch {
        // Malformed payload — fall through, nothing to prefill.
      }
      return;
    }

    const prefillUrl = sessionStorage.getItem("polluxa_new_campaign_url");
    if (prefillUrl) {
      setProductUrl(prefillUrl);
      sessionStorage.removeItem("polluxa_new_campaign_url");
    }
  }, []);

  useEffect(() => {
    if (!productsModalOpen) return;
    let cancelled = false;
    setCatalogLoading(true);
    setCatalogError(null);
    api
      .listProductCatalog(workspaceId, productsModalTab)
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch((err) => {
        if (!cancelled) setCatalogError(err instanceof Error ? err.message : "Couldn't load products");
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productsModalOpen, productsModalTab, workspaceId]);

  async function handleParseUrl() {
    const url = productUrl.trim();
    if (!url) return;
    setParseError(null);
    setParsing(true);
    try {
      const site = await api.scrapeWebsite(url);
      const analysis: ProductAnalysis = await api.analyzeProduct(site);
      setProducts((prev) => [
        ...prev,
        { id: `url-${prev.length}-${Date.now()}`, url, name: analysis.productName, category: analysis.category, summary: analysis.summary },
      ]);
      setProductUrl("");
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Couldn't parse that URL");
    } finally {
      setParsing(false);
    }
  }

  function removeProduct(id: string) {
    setProducts((prev) => prev.filter((p) => p.id !== id));
  }

  function toggleCatalogItem(item: ProductCatalogItem) {
    const id = `catalog-${item.id}`;
    setProducts((prev) =>
      prev.some((p) => p.id === id)
        ? prev.filter((p) => p.id !== id)
        : [
            ...prev,
            {
              id,
              url: item.url,
              name: item.name,
              category: item.category,
              summary: `${formatMoney(item.priceCents)} · via ${item.source}`,
            },
          ]
    );
  }

  async function toggleHistorical() {
    const next = !historicalOpen;
    setHistoricalOpen(next);
    setProductsModalOpen(false);
    if (next && historicalDrafts === null) {
      setHistoricalLoading(true);
      try {
        const drafts = await api.listDrafts(workspaceId);
        setHistoricalDrafts(drafts);
      } catch {
        setHistoricalDrafts([]);
      } finally {
        setHistoricalLoading(false);
      }
    }
  }

  function pickHistoricalDraft(draft: Draft) {
    setProducts((prev) => [
      ...prev,
      { id: `draft-${draft.id}`, name: draft.name, category: "Historical campaign", summary: draft.aiRecommendation ?? "Reused from a previous draft." },
    ]);
    setHistoricalOpen(false);
  }

  // Opens the store/catalog product picker. Intentionally retained but currently unreachable:
  // store/catalog sync is deferred ("Coming Soon" — see the disabled "Pick from store" button and
  // constants/platforms.ts), so no UI path calls this today. Kept for the future version that
  // re-enables catalog sync; the referenced-by-JSX modal below stays wired to it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function openProductsModal(tab: "all" | "shopify" | "facebook" | "google") {
    setHistoricalOpen(false);
    setProductsModalTab(tab);
    setProductsModalOpen(true);
  }

  function goConnectDataSource() {
    setProductsModalOpen(false);
    navigate("/profile/ad-platform-connection");
  }


  async function handleGenerate() {
    setGenerateError(null);
    if (channels.length === 0) {
      setGenerateError("Choose at least one placement channel.");
      return;
    }
    if (products.length === 0) {
      setGenerateError("Add at least one product to promote.");
      return;
    }
    const dailyBudgetCents = Math.round(parseFloat(dailyBudget) * 100);
    if (!dailyBudgetCents || dailyBudgetCents <= 0) {
      setGenerateError("Enter a valid daily budget.");
      return;
    }

    setGenerating(true);
    const primaryProduct = products[0];
    const url = primaryProduct.url ?? `https://example.com/${encodeURIComponent(primaryProduct.name)}`;

    try {
      const channelLabels = channels.map(c => c === "meta" ? "Meta Ads" : c === "google" ? "Google Ads" : c === "tiktok" ? "TikTok" : c).join(" + ");
      setGenerationStage(`Researching product for ${channelLabels}…`);

      const genResult = await api.generateCampaign({
        workspaceId,
        businessId,
        url,
        name: `${(objective[0] ?? "sales").charAt(0).toUpperCase() + (objective[0] ?? "sales").slice(1)} — ${channelLabels}`,
        dailyBudgetCents,
        channels: channels as any[],
        objective: objective[0],
        countries: countries.length > 0 ? countries : undefined,
      });

      if (genResult.status === "completed" && genResult.campaignId) {
        navigate(await campaignPathById(genResult.campaignId, api.getCampaign));
        return;
      }

      setGenerationStage("Running AI agents — strategy, audience, creative…");
      const jobId = genResult.id;
      const start = Date.now();
      const timeoutMs = 180000;

      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const progress = await api.getCampaignGenerationProgress(jobId);
          if (progress.completedSteps.length > 0) {
            const lastStep = progress.completedSteps[progress.completedSteps.length - 1];
            setGenerationStage(`${lastStep} (${progress.completedSteps.length}/${progress.total})…`);
          }
        } catch { /* progress endpoint optional */ }

        const status = await api.getCampaignGenerationStatus(jobId);
        if (status.status === "completed") {
          if (status.campaignId) {
            navigate(await campaignPathById(status.campaignId, api.getCampaign));
          } else {
            navigate("/campaigns");
          }
          return;
        }
        if (status.status === "failed") {
          throw new Error(status.error ?? "Campaign generation failed");
        }
      }

      throw new Error("Generation timed out — check Campaigns for status");
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Failed to generate campaign");
    } finally {
      setGenerating(false);
      setGenerationStage(null);
    }
  }

  return (
    <div className="page-campaign-generator">
      <div className="gen-allset-banner">
        <span className="gen-allset-emoji">🎉</span>
        <span><strong>All set! Your best ad strategy is ready.</strong> Review your goals below and start your campaign with one click!</span>
      </div>

      {/* The "Promotion Objective" review card now lives in the Deep Research flow
          (components/PromotionObjectiveCard.tsx, rendered on /campaigns/new after each URL search).
          The generate below still uses these defaults (objective/channels/countries/budget). */}

      <section className="gen-card">
        <div className="gen-card-header">
          <span className="gen-card-icon gen-card-icon-purple">
            <ShoppingBagIcon />
          </span>
          <h2>Add products to promote</h2>
        </div>

        {parseError && <p className="error mb-2">{parseError}</p>}

        <div className="gen-url-drop">
          <span className="gen-url-drop-icon">
            <LinkIcon />
          </span>
          <input
            type="text"
            placeholder="Paste target URL and press Enter to parse..."
            value={productUrl}
            onChange={(e) => setProductUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleParseUrl()}
            disabled={parsing}
            data-testid="product-url-input"
          />
          <button type="button" className="gen-url-drop-add" onClick={handleParseUrl} disabled={parsing || !productUrl.trim()} aria-label="Parse URL" data-testid="parse-url-button">
            <PlusIcon />
          </button>
        </div>

        <div className="gen-catalog-actions">
          <div className="gen-catalog-action-wrap">
            <button type="button" className="btn btn-secondary" onClick={toggleHistorical}>
              <HistoryIcon />
              Pick from historical catalog
            </button>
            {historicalOpen && (
              <div className="gen-catalog-panel">
                {historicalLoading && <p className="muted-text">Loading past drafts…</p>}
                {!historicalLoading && historicalDrafts?.length === 0 && (
                  <p className="muted-text">No historical drafts found yet.</p>
                )}
                {!historicalLoading && historicalDrafts?.map((d) => (
                  <div key={d.id} className="gen-catalog-panel-item" onClick={() => pickHistoricalDraft(d)}>
                    {d.name}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="gen-catalog-action-wrap">
            {/* Store/catalog sync is deferred to a future version — disabled with a "Coming Soon"
                badge so there's no UI path into the store-connect modal. Add products via the URL
                field above or the historical-catalog picker instead. */}
            <button
              type="button"
              className="btn btn-secondary disabled"
              disabled
              aria-disabled
              title="Store & catalog sync is coming soon — add products by URL for now"
              style={{ opacity: 0.5, cursor: "not-allowed" }}
            >
              <ShoppingBagIcon />
              Pick from store
              <span className="coming-soon-badge">{CATALOG_COMING_SOON_LABEL}</span>
            </button>
          </div>
        </div>

        {products.length > 0 && (
          <div className="gen-products-list">
            {products.map((p) => (
              <div key={p.id} className="gen-product-card">
                <div>
                  <strong>{p.name}</strong>
                  <span className="gen-product-category">{p.category}</span>
                  <p>{p.summary}</p>
                </div>
                <button type="button" className="gen-product-remove" onClick={() => removeProduct(p.id)} aria-label={`Remove ${p.name}`}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {generateError && <p className="error mb-2">{generateError}</p>}

      <div className="gen-footer-actions">
        {generationStage && (
          <div className="gen-progress-indicator" data-testid="generation-stage">
            <span className="gen-progress-spinner" />
            <span className="gen-progress-text">{generationStage}</span>
          </div>
        )}
        <button type="button" className="btn btn-primary gen-generate-btn" onClick={handleGenerate} disabled={generating} data-testid="generate-campaign-button">
          {generating ? "Generating..." : "✦ Generate Campaign"}
        </button>
      </div>

      {productsModalOpen && (
        <div className="gen-modal-overlay" onClick={() => setProductsModalOpen(false)}>
          <div className="gen-modal" onClick={(e) => e.stopPropagation()}>
            <div className="gen-modal-header">
              <h2>Select products</h2>
              <button type="button" className="gen-modal-close" onClick={() => setProductsModalOpen(false)} aria-label="Close">
                <XIcon />
              </button>
            </div>

            <div className="gen-modal-toolbar">
              <div className="gen-modal-tabs">
                {PRODUCT_SOURCE_TABS.map((tab) => (
                  <button
                    key={tab.value}
                    type="button"
                    data-tab={tab.value}
                    className={`gen-modal-tab ${productsModalTab === tab.value ? "active" : ""}`}
                    onClick={() => setProductsModalTab(tab.value)}
                  >
                    <span className="gen-modal-tab-icon">{tab.icon}</span>
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="gen-modal-search">
                <SearchIcon />
                <input
                  type="text"
                  placeholder="Search by product name or URL..."
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                />
              </div>
            </div>

            {(() => {
              const catalogItems = (catalog ?? []).flatMap((r) => r.items);
              const catalogConnected = (catalog ?? []).some((r) => r.connected);
              const query = productSearch.trim().toLowerCase();
              const filteredItems = query
                ? catalogItems.filter((item) => item.name.toLowerCase().includes(query) || item.url.toLowerCase().includes(query))
                : catalogItems;
              const showGrid = !catalogLoading && !catalogError && catalogConnected;

              return (
                <div className={`gen-modal-body ${showGrid ? "gen-modal-body-grid" : ""}`}>
                  {catalogLoading && <p className="muted-text">Loading products…</p>}

                  {!catalogLoading && catalogError && <p className="error">{catalogError}</p>}

                  {!catalogLoading && !catalogError && !catalogConnected && (
                    <div className="gen-modal-empty">
                      <span className="gen-modal-empty-icon">
                        <ShoppingBagIcon />
                      </span>
                      <p>Connect your store to sync products automatically or manually set up a product for analysis.</p>
                      <button type="button" className="btn btn-primary gen-modal-connect-btn" onClick={goConnectDataSource}>
                        <PlusIcon />
                        Connect product data source
                      </button>
                    </div>
                  )}

                  {showGrid && filteredItems.length === 0 && (
                    <p className="muted-text">No products match your search.</p>
                  )}

                  {showGrid && filteredItems.length > 0 && (
                    <div className="gen-modal-grid">
                      {filteredItems.map((item) => {
                        const selected = products.some((p) => p.id === `catalog-${item.id}`);
                        return (
                          <button
                            type="button"
                            key={item.id}
                            className={`gen-modal-product ${selected ? "selected" : ""}`}
                            onClick={() => toggleCatalogItem(item)}
                          >
                            <img src={item.imageUrl} alt={item.name} />
                            <div className="gen-modal-product-info">
                              <strong>{item.name}</strong>
                              <span>{item.category} · {formatMoney(item.priceCents)}</span>
                            </div>
                            <span className="gen-modal-product-check">{selected ? "✓ Added" : "Add"}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
