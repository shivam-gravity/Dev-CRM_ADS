import { useEffect, useRef, useState } from "react";
import { SparkleIcon } from "../components/icons.js";
import { api, GenerationJob } from "../api/client.js";

const SELECT_TYPES = [
  { value: "product-url", label: "Product URL" },
  { value: "text-prompt", label: "Text prompt" },
  { value: "upload", label: "User upload (coming soon)" },
];

const POLL_INTERVAL_MS = 2000;

function RegenerateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function formatTimestamp(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const JOBS_STORAGE_KEY = "polluxa_gen_jobs";

function loadStoredJobs(): GenerationJob[] {
  try { return JSON.parse(localStorage.getItem(JOBS_STORAGE_KEY) || "[]"); } catch { return []; }
}

export default function CreativeStudio({ businessId }: { businessId: string }) {
  const [selectType, setSelectType] = useState(SELECT_TYPES[0].value);
  const [productUrl, setProductUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [wantVideo, setWantVideo] = useState(false);
  const [fetchingImages, setFetchingImages] = useState(false);
  const [fetchedCount, setFetchedCount] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<GenerationJob[]>(loadStoredJobs);
  const pollHandles = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  useEffect(() => {
    localStorage.setItem(JOBS_STORAGE_KEY, JSON.stringify(jobs));
  }, [jobs]);

  useEffect(() => {
    jobs.filter((j) => j.status === "queued" || j.status === "running").forEach((j) => pollJob(j.id));
    return () => {
      Object.values(pollHandles.current).forEach(clearInterval);
    };
  }, []);

  function pollJob(jobId: string) {
    pollHandles.current[jobId] = setInterval(async () => {
      try {
        const updated = await api.getGenerationJob(jobId);
        setJobs((prev) => prev.map((j) => (j.id === jobId ? updated : j)));
        if (updated.status === "done" || updated.status === "failed") {
          clearInterval(pollHandles.current[jobId]);
          delete pollHandles.current[jobId];
        }
      } catch {
        clearInterval(pollHandles.current[jobId]);
        delete pollHandles.current[jobId];
      }
    }, POLL_INTERVAL_MS);
  }

  async function handleFetchImages() {
    if (!productUrl.trim()) return;
    setError(null);
    setFetchingImages(true);
    setFetchedCount(null);
    try {
      const site = await api.scrapeWebsite(productUrl.trim());
      setFetchedCount(site.images.length);
    } catch {
      setError("Couldn't fetch that page. Check the URL and try again.");
    } finally {
      setFetchingImages(false);
    }
  }

  async function handleSubmit() {
    if (selectType === "product-url" && !productUrl.trim()) {
      setError("Please enter a product URL to continue.");
      return;
    }
    if (selectType === "text-prompt" && !prompt.trim()) {
      setError("Please describe what you want generated.");
      return;
    }
    if (selectType === "upload") {
      setError("User upload is coming soon — use a product URL or text prompt for now.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const job = await api.createGenerationJob(businessId, {
        businessId,
        productUrl: selectType === "product-url" ? productUrl.trim() : undefined,
        prompt: selectType === "text-prompt" ? prompt.trim() : undefined,
        wantVideo,
      });
      setJobs((prev) => [job, ...prev]);
      pollJob(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start generation.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRegenerate(job: GenerationJob) {
    setError(null);
    try {
      const next = await api.createGenerationJob(job.workspaceId, job.input);
      setJobs((prev) => [next, ...prev.filter((j) => j.id !== job.id)]);
      pollJob(next.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to regenerate.");
    }
  }

  return (
    <div className="ai-generate-page" data-business-id={businessId}>

      <div className="ai-generate-toolbar">
        <span className="ai-generate-toolbar-hint">Enter a product URL or text prompt to generate ad creatives with AI.</span>
      </div>

      <div className="ai-generate-layout">
        <section className="ai-generate-form gen-card">
          <label className="ai-generate-field">
            <span className="ai-generate-field-label">Select Type</span>
            <select
              className="ai-generate-select"
              value={selectType}
              onChange={(e) => { setSelectType(e.target.value); setError(null); }}
            >
              {SELECT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </label>

          {selectType === "product-url" && (
            <label className="ai-generate-field">
              <span className="ai-generate-field-label">
                <span className="polluxa-required">*</span> Product URL
                <span className="ai-generate-info-icon" title="Paste a link to the product page you want to advertise.">i</span>
              </span>
              <div className="ai-generate-url-row">
                <input
                  type="text"
                  className="ai-generate-url-input"
                  placeholder="Please enter product URL"
                  value={productUrl}
                  onChange={(e) => { setProductUrl(e.target.value); setFetchedCount(null); }}
                />
                <button
                  type="button"
                  className="btn btn-secondary ai-generate-fetch-btn"
                  onClick={handleFetchImages}
                  disabled={!productUrl.trim() || fetchingImages}
                >
                  {fetchingImages ? "Fetching…" : "Fetch Images"}
                </button>
              </div>
              {fetchedCount !== null && (
                <span className="ai-generate-fetch-note">Found {fetchedCount} images on this page.</span>
              )}
            </label>
          )}

          {selectType === "text-prompt" && (
            <label className="ai-generate-field">
              <span className="ai-generate-field-label">
                <span className="polluxa-required">*</span> Describe the creative
              </span>
              <textarea
                className="ai-generate-url-input"
                rows={4}
                placeholder="e.g. A pair of running shoes on a sunlit trail, energetic and outdoorsy"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
          )}

          <label className="ai-generate-field ai-generate-checkbox-field">
            <input type="checkbox" checked={wantVideo} onChange={(e) => setWantVideo(e.target.checked)} />
            <span>Also generate a short video from the image</span>
          </label>

          {error && <p className="error">{error}</p>}

          <button
            type="button"
            className="btn btn-primary ai-generate-submit-btn"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? "Starting…" : "Submit Now"}
          </button>
        </section>

        <div className="ai-generate-results-feed">
          {jobs.length === 0 && (
            <div className="ai-generate-empty empty-state">
              <span className="empty-icon" aria-hidden="true">✨</span>
              <p>Your AI-generated creatives will show up here after you submit a product URL or prompt.</p>
            </div>
          )}

          {jobs.map((job) => (
            <section key={job.id} className="ai-generate-result-card gen-card">
              <div className="ai-generate-result-header">
                <span className="ai-generate-result-avatar" aria-hidden="true">
                  <SparkleIcon />
                </span>
                <div className="ai-generate-result-meta">
                  <strong>CRM Ads Creative Expert</strong>
                  <span>{job.status === "done" ? job.result?.headline : job.status}</span>
                </div>
                <span className="ai-generate-result-timestamp">{formatTimestamp(new Date(job.createdAt).getTime())}</span>
              </div>

              <div className="ai-generate-result-image-wrap">
                {job.status === "queued" || job.status === "running" ? (
                  <div className="image-loading-skeleton">
                    <div className="onboarding-spinner" />
                    <span>{job.input.wantVideo ? "Generating image + video…" : "Generating custom asset…"}</span>
                  </div>
                ) : job.status === "failed" ? (
                  <p className="error">{job.error ?? "Generation failed."}</p>
                ) : job.result?.videoUrl ? (
                  <video src={job.result.videoUrl} poster={job.result.imageUrl} controls />
                ) : (
                  <img src={job.result?.imageUrl} alt={job.result?.headline ?? "AI generated creative"} />
                )}
              </div>

              {job.status === "done" && (
                <p className="muted-text ai-generate-copy-preview">
                  <strong>{job.result?.headline}</strong> — {job.result?.body} ({job.result?.callToAction})
                </p>
              )}

              <button
                type="button"
                className="btn btn-secondary btn-sm ai-generate-regenerate-btn"
                onClick={() => handleRegenerate(job)}
                disabled={job.status === "queued" || job.status === "running"}
              >
                <RegenerateIcon />
                Regenerate
              </button>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
