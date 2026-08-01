import { currentWorkspaceId } from "../lib/workspace.js";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.js";
import { api, CatalogSourceResult, ProductAnalysis, ProductCatalogItem, ProductCatalogSource } from "../api/client.js";
import { isCatalogSourceActive, CATALOG_COMING_SOON_LABEL } from "../constants/platforms.js";
import {
  SearchIcon,
  PlusIcon,
  InboxIcon,
  CloseIcon,
  SparkleIcon,
  ShopifyIcon,
  MetaInfinityIcon,
  GoogleGmcIcon,
  LinkIcon,
  FormIcon,
  ChevronRightIcon,
  ArrowLeftIcon,
} from "../components/icons.js";
import { useCurrency } from "../providers/CurrencyProvider.js";

interface ProductRow {
  id: string;
  name: string;
  category: string;
  source: string;
  updatedAt: number;
}

type AddStep = "choose" | "shopify" | "facebook" | "google" | "url" | "manual";

const STORAGE_KEY = "polluxa_products";

function loadProducts(): ProductRow[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch { return []; }
}

function saveProducts(products: ProductRow[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(products));
}

const SYNC_METHODS: { step: "shopify" | "facebook" | "google"; source: ProductCatalogSource; title: string; description: string; icon: React.ReactNode }[] = [
  { step: "shopify", source: "shopify", title: "Sync from Shopify", description: "Automatically import and update all your products from Shopify", icon: <ShopifyIcon /> },
  { step: "facebook", source: "facebook", title: "Sync From Meta Feeds", description: "Import products directly from your Meta Commerce Manager", icon: <MetaInfinityIcon /> },
  { step: "google", source: "google", title: "Sync From Google GMC", description: "Import products directly from your Google Merchant Center", icon: <GoogleGmcIcon /> },
];

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "2-digit", year: "numeric" });
}

export default function Products() {
  const navigate = useNavigate();
  // ProductCatalogItem carries no currency of its own, so catalog prices render in the workspace
  // currency. That beats the hardcoded "$" this replaced, but it does assume the connected store
  // prices in the same currency the ad account bills in — add a per-item currency if that breaks.
  const { format: formatMoney } = useCurrency();
  const { workspaceId: authWsId } = useAuth();
  const workspaceId = currentWorkspaceId(authWsId);

  const [products, setProducts] = useState<ProductRow[]>(loadProducts);
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [step, setStep] = useState<AddStep>("choose");

  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [manualName, setManualName] = useState("");
  const [manualCategory, setManualCategory] = useState("");
  const [manualPrice, setManualPrice] = useState("");
  const [manualUrl, setManualUrl] = useState("");

  const [catalog, setCatalog] = useState<CatalogSourceResult | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const filtered = products.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()));
  const activeSyncMethod = SYNC_METHODS.find((m) => m.step === step);

  useEffect(() => { saveProducts(products); }, [products]);

  useEffect(() => {
    if (!modalOpen || !activeSyncMethod) return;
    let cancelled = false;
    setCatalog(null);
    setCatalogLoading(true);
    setCatalogError(null);
    api
      .listProductCatalog(workspaceId, activeSyncMethod.source)
      .then((result) => { if (!cancelled) setCatalog(result[0] ?? null); })
      .catch((err) => { if (!cancelled) setCatalogError(err instanceof Error ? err.message : "Couldn't load products"); })
      .finally(() => { if (!cancelled) setCatalogLoading(false); });
    return () => { cancelled = true; };
  }, [modalOpen, step, workspaceId]);

  function openAddModal() {
    setStep("choose");
    setError(null);
    setModalOpen(true);
  }

  function closeModal() {
    if (adding) return;
    setModalOpen(false);
    setError(null);
  }

  function backToChoose() {
    setStep("choose");
    setError(null);
  }

  async function handleAddProduct() {
    if (!url.trim()) return;
    setError(null);
    setAdding(true);
    try {
      const site = await api.scrapeWebsite(url.trim());
      const analysis: ProductAnalysis = await api.analyzeProduct(site);
      setProducts((prev) => [
        { id: `${Date.now()}`, name: analysis.productName, category: analysis.category, source: url.trim(), updatedAt: Date.now() },
        ...prev,
      ]);
      setUrl("");
      setModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that product");
    } finally {
      setAdding(false);
    }
  }

  function handleManualSubmit() {
    if (!manualName.trim()) return;
    if (manualPrice.trim() && (!Number.isFinite(Number(manualPrice.trim())) || Number(manualPrice.trim()) < 0)) {
      setError("Enter a valid, non-negative price");
      return;
    }
    setError(null);
    setProducts((prev) => [
      {
        id: `manual-${Date.now()}`,
        name: manualName.trim(),
        category: manualCategory.trim() || "—",
        source: manualUrl.trim() || (manualPrice.trim() ? `$${manualPrice.trim()}` : "Manual entry"),
        updatedAt: Date.now(),
      },
      ...prev,
    ]);
    setManualName("");
    setManualCategory("");
    setManualPrice("");
    setManualUrl("");
    setModalOpen(false);
  }

  function addCatalogItem(item: ProductCatalogItem) {
    setProducts((prev) => {
      const id = `catalog-${item.id}`;
      if (prev.some((p) => p.id === id)) return prev;
      return [{ id, name: item.name, category: item.category, source: item.url, updatedAt: Date.now() }, ...prev];
    });
  }

  function removeProduct(id: string) {
    setProducts((prev) => prev.filter((p) => p.id !== id));
  }

  return (
    <div className="page-products">

      <div className="polluxa-table-toolbar">
        <label className="polluxa-search-input">
          <SearchIcon />
          <input
            type="text"
            placeholder="Search by product name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button type="button" className="btn btn-primary" onClick={openAddModal}>
          <PlusIcon /> Add Product
        </button>
      </div>

      <div className="polluxa-table-card">
        <div className="polluxa-table-row polluxa-table-head">
          <span>Product</span>
          <span>Category</span>
          <span>Source</span>
          <span>Updated</span>
          <span>Actions</span>
        </div>

        {filtered.length === 0 ? (
          <div className="polluxa-table-empty">
            <InboxIcon />
            <p>No products yet. Add one to get started.</p>
          </div>
        ) : (
          filtered.map((p) => (
            <div key={p.id} className="polluxa-table-row">
              <span className="polluxa-table-row-name">{p.name}</span>
              <span className="polluxa-table-row-source">{p.category}</span>
              <span className="polluxa-table-row-source">{p.source.length > 40 ? p.source.slice(0, 40) + "…" : p.source}</span>
              <span>{formatDate(p.updatedAt)}</span>
              <span>
                <button
                  type="button"
                  className="polluxa-table-row-remove"
                  onClick={() => removeProduct(p.id)}
                  aria-label={`Remove ${p.name}`}
                >
                  <CloseIcon />
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      {modalOpen && (
        <div className="polluxa-modal-overlay" onClick={closeModal}>
          <div className="polluxa-modal polluxa-modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="polluxa-modal-header">
              {step !== "choose" && (
                <button type="button" className="polluxa-modal-close" onClick={backToChoose} aria-label="Back">
                  <ArrowLeftIcon />
                </button>
              )}
              <h2>
                {step === "choose" && "How do you want to add product?"}
                {step === "url" && "Import from URL"}
                {step === "manual" && "Enter product details"}
                {activeSyncMethod?.title}
              </h2>
              <button type="button" className="polluxa-modal-close" onClick={closeModal} aria-label="Close">
                <CloseIcon />
              </button>
            </div>

            {step === "choose" && (
              <div className="product-method-list">
                {SYNC_METHODS.map((m) => {
                  // Store/catalog sync (Shopify, Meta feeds, Google GMC) is deferred to a future
                  // version — render non-clickable with reduced opacity and a "Coming Soon" badge.
                  // URL import + manual entry below stay fully active.
                  const comingSoon = !isCatalogSourceActive(m.source);
                  return (
                    <button
                      type="button"
                      key={m.step}
                      className={`product-method-row ${comingSoon ? "disabled" : ""}`}
                      onClick={comingSoon ? undefined : () => setStep(m.step)}
                      disabled={comingSoon}
                      aria-disabled={comingSoon || undefined}
                      style={comingSoon ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
                    >
                      <span className="product-method-icon">{m.icon}</span>
                      <span className="product-method-text">
                        <strong>{m.title}{comingSoon ? ` — ${CATALOG_COMING_SOON_LABEL}` : ""}</strong>
                        <span>{m.description}</span>
                      </span>
                      {comingSoon ? (
                        <span className="coming-soon-badge">{CATALOG_COMING_SOON_LABEL}</span>
                      ) : (
                        <ChevronRightIcon className="product-method-chevron" />
                      )}
                    </button>
                  );
                })}
                <button type="button" className="product-method-row" onClick={() => setStep("url")}>
                  <span className="product-method-icon">
                    <LinkIcon />
                  </span>
                  <span className="product-method-text">
                    <strong>Import from URL</strong>
                    <span>Paste a product page link and we'll pull the details for you</span>
                  </span>
                  <ChevronRightIcon className="product-method-chevron" />
                </button>
                <button type="button" className="product-method-row" onClick={() => setStep("manual")}>
                  <span className="product-method-icon">
                    <FormIcon />
                  </span>
                  <span className="product-method-text">
                    <strong>Enter Manually</strong>
                    <span>Manually enter all the product details</span>
                  </span>
                  <ChevronRightIcon className="product-method-chevron" />
                </button>
              </div>
            )}

            {step === "url" && (
              <>
                {error && <p className="error">{error}</p>}
                <label className="polluxa-modal-field">
                  <span>Product URL</span>
                  <input
                    type="text"
                    placeholder="e.g. https://www.yourstore.com/products/item"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAddProduct()}
                    autoFocus
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-primary polluxa-modal-submit"
                  onClick={handleAddProduct}
                  disabled={adding || !url.trim()}
                >
                  <SparkleIcon /> {adding ? "Analyzing…" : "Add Product"}
                </button>
              </>
            )}

            {step === "manual" && (
              <>
                {error && <p className="error">{error}</p>}
                <label className="polluxa-modal-field">
                  <span>Product name</span>
                  <input type="text" placeholder="e.g. Aurora Wireless Earbuds" value={manualName} onChange={(e) => setManualName(e.target.value)} autoFocus />
                </label>
                <label className="polluxa-modal-field">
                  <span>Category</span>
                  <input type="text" placeholder="e.g. Electronics" value={manualCategory} onChange={(e) => setManualCategory(e.target.value)} />
                </label>
                <label className="polluxa-modal-field">
                  <span>Price (USD)</span>
                  <input type="number" min="0" placeholder="e.g. 49.99" value={manualPrice} onChange={(e) => setManualPrice(e.target.value)} />
                </label>
                <label className="polluxa-modal-field">
                  <span>Product URL (optional)</span>
                  <input type="text" placeholder="e.g. https://www.yourstore.com/products/item" value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} />
                </label>
                <button type="button" className="btn btn-primary polluxa-modal-submit" onClick={handleManualSubmit} disabled={!manualName.trim()}>
                  <PlusIcon /> Add Product
                </button>
              </>
            )}

            {activeSyncMethod && (
              <div className="product-sync-body">
                {catalogLoading && <p className="muted-text">Loading products…</p>}
                {!catalogLoading && catalogError && <p className="error">{catalogError}</p>}

                {!catalogLoading && !catalogError && catalog && !catalog.connected && (
                  <div className="gen-modal-empty">
                    <span className="gen-modal-empty-icon">{activeSyncMethod.icon}</span>
                    <p>Connect {activeSyncMethod.title.replace("Sync from ", "").replace("Sync From ", "")} to import products automatically.</p>
                    <button type="button" className="btn btn-primary gen-modal-connect-btn" onClick={() => navigate("/profile/ad-platform-connection")}>
                      <PlusIcon />
                      Connect product data source
                    </button>
                  </div>
                )}

                {!catalogLoading && !catalogError && catalog?.connected && (
                  <div className="gen-modal-grid">
                    {catalog.items.map((item) => {
                      const added = products.some((p) => p.id === `catalog-${item.id}`);
                      return (
                        <button
                          type="button"
                          key={item.id}
                          className={`gen-modal-product ${added ? "selected" : ""}`}
                          onClick={() => addCatalogItem(item)}
                          disabled={added}
                        >
                          <img src={item.imageUrl} alt={item.name} />
                          <div className="gen-modal-product-info">
                            <strong>{item.name}</strong>
                            <span>{item.category} · {formatMoney(item.priceCents)}</span>
                          </div>
                          <span className="gen-modal-product-check">{added ? "✓ Added" : "Add"}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
