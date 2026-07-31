import { currentWorkspaceId } from "../lib/workspace.js";
import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.js";
import {
  api,
  BusinessProfile,
  ProductAnalysis,
  AudienceAnalysis,
  CompanyProfileRecord,
} from "../api/client.js";
import {
  SparkleIcon,
  GlobeIcon,
  CloseIcon,
  UserIcon,
  TargetIcon,
  LightningIcon,
} from "../components/icons.js";

type AnalysisStep = "idle" | "scraping" | "analyzing_product" | "analyzing_audience" | "persisting" | "done" | "error";

const STEP_LABELS: Record<AnalysisStep, string> = {
  idle: "",
  scraping: "Crawling website…",
  analyzing_product: "AI analyzing products & features…",
  analyzing_audience: "AI analyzing audience & market…",
  persisting: "Saving brand profile…",
  done: "Complete",
  error: "Failed",
};

export default function BrandProfile() {
  const { businessId, workspaceId } = useAuth();
  const wsId = currentWorkspaceId(workspaceId);
  const bizId = businessId ?? "demo-business";

  const [business, setBusiness] = useState<BusinessProfile | null>(null);
  const [product, setProduct] = useState<ProductAnalysis | null>(null);
  const [audience, setAudience] = useState<AudienceAnalysis | null>(null);
  const [companyProfile, setCompanyProfile] = useState<CompanyProfileRecord | null>(null);
  const [loading, setLoading] = useState(true);

  const [modalOpen, setModalOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [step, setStep] = useState<AnalysisStep>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.getBusiness(bizId).catch(() => null),
      api.getCompanyProfile(bizId).catch(() => null),
    ]).then(([biz, cp]) => {
      if (cancelled) return;
      if (biz) setBusiness(biz);
      if (cp) setCompanyProfile(cp);
      if (!biz?.website && !cp) setModalOpen(true);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [bizId]);

  async function handleAnalyze() {
    if (!url.trim()) return;
    setError(null);
    setStep("scraping");
    try {
      const site = await api.scrapeWebsite(url.trim());
      setStep("analyzing_product");
      const prod = await api.analyzeProduct(site);
      setProduct(prod);
      setStep("analyzing_audience");
      const aud = await api.analyzeAudience(site, prod);
      setAudience(aud);
      setStep("persisting");
      const updated = await api.updateBusiness(bizId, {
        website: url.trim(),
        name: prod.productName || business?.name || "My Brand",
        brandName: prod.productName,
        industry: prod.category || business?.industry || "General",
      });
      setBusiness(updated);
      api.getCompanyProfile(bizId).then(setCompanyProfile).catch(() => {});
      setStep("done");
      setTimeout(() => { setModalOpen(false); setStep("idle"); }, 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
      setStep("error");
    }
  }

  const hasProfile = business?.website || companyProfile || product;

  if (loading) return (
    <div className="page-brand-profile">
      <div className="bp-loading">Loading brand profile…</div>
    </div>
  );

  return (
    <div className={`page-brand-profile ${modalOpen ? "polluxa-modal-dimmed" : ""}`}>
      {hasProfile ? (
        <div className="bp-layout">
          {/* Hero */}
          <section className="bp-hero">
            <div className="bp-hero-left">
              <div className="bp-brand-mark">
                {(business?.brandName || business?.name || "B").charAt(0).toUpperCase()}
              </div>
              <div className="bp-hero-info">
                <h2 className="bp-brand-name">{business?.brandName || business?.name || "My Brand"}</h2>
                <p className="bp-brand-industry">{business?.industry || product?.category || "—"}</p>
                {business?.website && (
                  <a className="bp-brand-url" href={business.website} target="_blank" rel="noreferrer">
                    <GlobeIcon /> {business.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                  </a>
                )}
              </div>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setStep("idle"); setError(null); setModalOpen(true); }}>
              <SparkleIcon /> Re-analyze
            </button>
          </section>

          {/* Summary / Value Prop */}
          <div className="bp-grid">
            <section className="bp-card">
              <h3 className="bp-card-title"><LightningIcon /> Value Proposition</h3>
              <p className="bp-card-text">{product?.valueProposition || companyProfile?.data.overview || "Run an analysis to generate your brand profile."}</p>
            </section>
            <section className="bp-card">
              <h3 className="bp-card-title"><TargetIcon /> Target Audience</h3>
              <p className="bp-card-text">{audience?.primaryAudience || companyProfile?.data.targetAudience || "—"}</p>
            </section>
          </div>

          {/* Key Features */}
          {/* Same 0-render trap as the Pain Points block below — see the comment there. */}
          {Boolean(product?.keyFeatures?.length || companyProfile?.data.features.length) && (
            <section className="bp-card bp-card-full">
              <h3 className="bp-card-title">Key Features &amp; Products</h3>
              <div className="bp-chip-grid">
                {(product?.keyFeatures || companyProfile?.data.features || []).map((f) => (
                  <span key={f} className="bp-chip">{f}</span>
                ))}
              </div>
            </section>
          )}

          {/* Audience Segments */}
          {audience?.segments && audience.segments.length > 0 && (
            <section className="bp-card bp-card-full">
              <h3 className="bp-card-title"><UserIcon /> Audience Segments</h3>
              <div className="bp-segments-grid">
                {audience.segments.map((seg) => (
                  <div key={seg.name} className="bp-segment">
                    <strong>{seg.name}</strong>
                    <p>{seg.description}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Pain Points & Motivations */}
          {/* Boolean(), not a bare `||` of two lengths: with both arrays empty that evaluates to the
              NUMBER 0, and React renders 0 as text — a stray "0" appeared between Target Audience
              and Positioning. `&&` only skips rendering for false/null/undefined, never for 0. */}
          {Boolean(audience?.painPoints?.length || audience?.buyingMotivations?.length) && (
            <div className="bp-grid">
              {audience?.painPoints && audience.painPoints.length > 0 && (
                <section className="bp-card">
                  <h3 className="bp-card-title">Pain Points</h3>
                  <ul className="bp-list">
                    {audience.painPoints.map((p) => <li key={p}>{p}</li>)}
                  </ul>
                </section>
              )}
              {audience?.buyingMotivations && audience.buyingMotivations.length > 0 && (
                <section className="bp-card">
                  <h3 className="bp-card-title">Buying Motivations</h3>
                  <ul className="bp-list">
                    {audience.buyingMotivations.map((m) => <li key={m}>{m}</li>)}
                  </ul>
                </section>
              )}
            </div>
          )}

          {/* Demographics */}
          {audience?.demographics && (
            <section className="bp-card bp-card-full">
              <h3 className="bp-card-title">Demographics</h3>
              <div className="bp-demo-grid">
                {audience.demographics.ageDistribution && (
                  <div className="bp-demo-item">
                    <span className="bp-demo-label">Age</span>
                    <span className="bp-demo-value">{audience.demographics.ageDistribution}</span>
                  </div>
                )}
                {audience.demographics.genderRatio && (
                  <div className="bp-demo-item">
                    <span className="bp-demo-label">Gender</span>
                    <span className="bp-demo-value">{audience.demographics.genderRatio}</span>
                  </div>
                )}
                {audience.demographics.occupation && (
                  <div className="bp-demo-item">
                    <span className="bp-demo-label">Occupation</span>
                    <span className="bp-demo-value">{audience.demographics.occupation}</span>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Company Profile deep data */}
          {companyProfile && (
            <>
              {companyProfile.data.positioning && (
                <section className="bp-card bp-card-full">
                  <h3 className="bp-card-title">Positioning</h3>
                  <p className="bp-card-text">{companyProfile.data.positioning}</p>
                </section>
              )}
              {companyProfile.data.messaging.length > 0 && (
                <section className="bp-card bp-card-full">
                  <h3 className="bp-card-title">Brand Messaging</h3>
                  <div className="bp-chip-grid">
                    {companyProfile.data.messaging.map((m) => <span key={m} className="bp-chip bp-chip-msg">{m}</span>)}
                  </div>
                </section>
              )}
              {companyProfile.data.socialProof.length > 0 && (
                <section className="bp-card bp-card-full">
                  <h3 className="bp-card-title">Social Proof</h3>
                  <ul className="bp-list">
                    {companyProfile.data.socialProof.map((s) => <li key={s}>{s}</li>)}
                  </ul>
                </section>
              )}
            </>
          )}

          {/* Business Goals */}
          {business?.goals && business.goals.length > 0 && (
            <section className="bp-card bp-card-full">
              <h3 className="bp-card-title">Business Goals</h3>
              <div className="bp-chip-grid">
                {business.goals.map((g) => <span key={g} className="bp-chip bp-chip-goal">{g}</span>)}
              </div>
            </section>
          )}
        </div>
      ) : (
        <div className="bp-empty">
          <div className="bp-empty-icon">
            <SparkleIcon />
          </div>
          <h2>Build your Brand Profile</h2>
          <p>Enter your website URL and AI will analyze your brand, products, audience, and competitive positioning.</p>
          <button type="button" className="btn btn-primary" onClick={() => { setStep("idle"); setError(null); setModalOpen(true); }}>
            <SparkleIcon /> Start Brand Analysis
          </button>
        </div>
      )}

      {/* Analysis Modal */}
      {modalOpen && (
        <div className="polluxa-modal-overlay" onClick={() => step === "idle" || step === "error" ? setModalOpen(false) : null}>
          <div className="polluxa-modal" onClick={(e) => e.stopPropagation()}>
            <div className="polluxa-modal-header">
              <span className="polluxa-modal-icon"><SparkleIcon /></span>
              <h2>Brand Analysis</h2>
              {(step === "idle" || step === "error") && (
                <button type="button" className="polluxa-modal-close" onClick={() => setModalOpen(false)} aria-label="Close">
                  <CloseIcon />
                </button>
              )}
            </div>

            {step !== "idle" && step !== "error" && (
              <div className="bp-progress">
                <div className="bp-progress-bar">
                  <div
                    className="bp-progress-fill"
                    style={{ width: step === "scraping" ? "25%" : step === "analyzing_product" ? "50%" : step === "analyzing_audience" ? "75%" : "100%" }}
                  />
                </div>
                <p className="bp-progress-label">{STEP_LABELS[step]}</p>
              </div>
            )}

            {(step === "idle" || step === "error") && (
              <>
                {error && <p className="error">{error}</p>}
                <label className="polluxa-modal-field">
                  <span><GlobeIcon /> Website URL</span>
                  <input
                    type="text"
                    placeholder="e.g. https://www.yourbrand.com"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
                    autoFocus
                  />
                </label>
                <p className="bp-modal-hint">AI will crawl your site, analyze products, audience, and build a complete brand profile.</p>
                <button
                  type="button"
                  className="btn btn-primary polluxa-modal-submit"
                  onClick={handleAnalyze}
                  disabled={!url.trim()}
                >
                  <SparkleIcon /> Start Analysis
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
