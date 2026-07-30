import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { usePageHeader } from "../context/PageHeaderContext.js";
import { DropdownField, type Option } from "../components/DropdownField.js";
import { useRealtime, useRealtimeChannel } from "../hooks/useRealtime.js";
import { useCurrency } from "../providers/CurrencyProvider.js";
import {
  api,
  type AdCreative,
  type Campaign,
  type CampaignVariant,
  type CreativeAssetRef,
  type GenerationJob,
  type GoogleConversionAction,
  type GoogleCustomer,
  type ImageAspectRatio,
  type ImageQuality,
  type MetaAdAccount,
  type MetaInstagramAccount,
  type MetaPage,
  type MetaPixel,
  type ReachEstimate,
} from "../api/client.js";

const CONVERSION_EVENT_OPTIONS: Option[] = [
  { value: "PURCHASE", label: "Purchase" },
  { value: "LEAD", label: "Lead" },
  { value: "ADD_TO_CART", label: "Add to Cart" },
  { value: "COMPLETE_REGISTRATION", label: "Complete Registration" },
];

const CTA_OPTIONS = ["Shop Now", "Learn More", "Sign Up", "Get Offer", "Download", "Contact Us"];

const MAX_CREATIVES = 10;
/** Largest raw file an upload can carry. Derived from the transport, not chosen: the file goes
 * base64-encoded inside a JSON body (~33% inflation) and the API caps JSON at 10mb, so ~7MB of raw
 * file is the ceiling. Kept slightly under to leave room for the JSON envelope and filename. */
const MAX_UPLOAD_BYTES = 7 * 1024 * 1024;
const MAX_COPY_VARIANTS = 5;
const MAX_ADS_SHOWN = 8;
const POLL_INTERVAL_MS = 2000;

function emptyCreative(): AdCreative {
  return { headline: "", body: "", callToAction: "Shop Now", headlines: [""], primaryTexts: [""] };
}

function emptyVariant(index: number, network: CampaignVariant["network"] = "meta"): CampaignVariant {
  return { id: `local-${index}-${Math.random().toString(36).slice(2, 8)}`, creative: emptyCreative(), network, status: "draft" };
}

function getHeadlines(creative: AdCreative): string[] {
  return creative.headlines?.length ? creative.headlines : [creative.headline || ""];
}

function getPrimaryTexts(creative: AdCreative): string[] {
  return creative.primaryTexts?.length ? creative.primaryTexts : [creative.body || ""];
}

function formatReach(estimate: ReachEstimate): string {
  const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`);
  return `${fmt(estimate.usersLowerBound)} - ${fmt(estimate.usersUpperBound)}`;
}

export default function CampaignBuilder() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const navigate = useNavigate();
  // "demo-workspace" matches AuthContext's own default and the seeded demo Business —
  // "demo" is a separate, also-real seeded workspace that demo-business does NOT belong
  // to, so falling back to it here would silently 403 every workspace-scoped call below.
  const wsId = localStorage.getItem("polluxa_workspace_id") ?? "demo-workspace";
  const { symbol, formatDaily } = useCurrency();

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Dynamic breadcrumb for the shell header: falls back to "…" until the campaign loads.
  usePageHeader({ breadcrumb: ["New Campaign", campaign?.name ?? "…"] });

  // Top-bar selectors
  const [adAccounts, setAdAccounts] = useState<MetaAdAccount[]>([]);
  const [pages, setPages] = useState<MetaPage[]>([]);
  const [instagramAccounts, setInstagramAccounts] = useState<MetaInstagramAccount[]>([]);
  const [pixels, setPixels] = useState<MetaPixel[]>([]);
  const [adAccountId, setAdAccountId] = useState("");
  const [pageId, setPageId] = useState("");
  const [instagramAccountId, setInstagramAccountId] = useState("");
  const [pixelId, setPixelId] = useState("");
  const [customers, setCustomers] = useState<GoogleCustomer[]>([]);
  const [googleAccountsLoaded, setGoogleAccountsLoaded] = useState(false);
  const [conversionActions, setConversionActions] = useState<GoogleConversionAction[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [conversionActionId, setConversionActionId] = useState("");
  const [newAdNetwork, setNewAdNetwork] = useState<CampaignVariant["network"]>("meta");

  // Ad Setting
  const [conversionEvent, setConversionEvent] = useState("PURCHASE");
  const [dailyBudget, setDailyBudget] = useState("25");
  const [startDate, setStartDate] = useState("");
  const [finalUrl, setFinalUrl] = useState("");

  // Target Audience
  const [locations, setLocations] = useState<string[]>(["United States"]);
  const [locationInput, setLocationInput] = useState("");
  const [advantagePlus, setAdvantagePlus] = useState(true);
  const [budgetMode, setBudgetMode] = useState<"ABO" | "CBO">("ABO");
  const [reach, setReach] = useState<ReachEstimate | null>(null);

  // Ads (variants) within this campaign
  const [variants, setVariants] = useState<CampaignVariant[]>([]);
  const [includedVariantIds, setIncludedVariantIds] = useState<Set<string>>(new Set());
  const [activeVariantId, setActiveVariantId] = useState<string | null>(null);
  const [copyExpanded, setCopyExpanded] = useState(false);

  // Ad Creatives
  const [creativeAssets, setCreativeAssets] = useState<CreativeAssetRef[]>([]);
  const [genJobs, setGenJobs] = useState<GenerationJob[]>([]);
  const [genAspectRatio, setGenAspectRatio] = useState<ImageAspectRatio>("square");
  const [genLanguage, setGenLanguage] = useState("English");
  const [genQuality, setGenQuality] = useState<ImageQuality>("standard");
  const pollHandles = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [saving, setSaving] = useState(false);
  const [saveConfirmed, setSaveConfirmed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { subscribe } = useRealtime(wsId, campaign?.businessId);

  const activeVariantIdRef = useRef(activeVariantId);
  activeVariantIdRef.current = activeVariantId;

  const handleCreativeEvent = useCallback((_channel: string, payload: unknown) => {
    const event = payload as { jobId?: string; status?: string; result?: GenerationJob["result"]; error?: string };
    if (!event?.jobId) return;
    setGenJobs((prev) => prev.map((j) => j.id === event.jobId ? { ...j, status: (event.status as GenerationJob["status"]) ?? j.status, result: event.result ?? j.result, error: event.error ?? j.error } : j));
    if (event.status === "done" && event.result) {
      clearInterval(pollHandles.current[event.jobId!]);
      delete pollHandles.current[event.jobId!];
      const url = event.result!.videoUrl ?? event.result!.imageUrl;
      const assetType = event.result!.videoUrl ? "video" as const : "image" as const;
      setCreativeAssets((prev) => {
        if (prev.length >= MAX_CREATIVES) return prev;
        return [...prev, { id: event.result!.imageAssetId, url, type: assetType, source: "ai" }];
      });
      const patch = assetType === "video" ? { videoUrl: url } : { imageUrl: url };
      setVariants((prev) => prev.map((v) => v.id === activeVariantIdRef.current ? { ...v, creative: { ...v.creative, ...patch } } : v));
    } else if (event.status === "failed") {
      clearInterval(pollHandles.current[event.jobId!]);
      delete pollHandles.current[event.jobId!];
      setActionError(event.error ?? "Creative generation failed");
    }
  }, []);

  useRealtimeChannel(subscribe, campaign ? `creative.generation:${campaign.businessId}` : null, handleCreativeEvent);

  useEffect(() => {
    if (!campaignId) return;
    api.getCampaign(campaignId).then((c) => {
      setCampaign(c);
      setAdAccountId(c.metaAdAccountId ?? "");
      setPageId(c.pageId ?? "");
      setInstagramAccountId(c.instagramAccountId ?? "");
      setPixelId(c.pixelId ?? "");
      setCustomerId(c.googleCustomerId ?? "");
      setConversionActionId(c.googleConversionActionId ?? "");
      setConversionEvent(c.conversionEvent ?? "PURCHASE");
      setDailyBudget(String(c.dailyBudgetCents / 100));
      setStartDate(c.startDate ?? "");
      setFinalUrl(c.finalUrl ?? c.variants[0]?.landingPageUrl ?? "");
      setLocations(c.locations?.length ? c.locations : ["United States"]);
      setAdvantagePlus(c.advantagePlus ?? true);
      setBudgetMode(c.budgetMode ?? "ABO");
      const startingVariants = c.variants.length ? c.variants : [emptyVariant(0)];
      setVariants(startingVariants);
      setIncludedVariantIds(new Set(startingVariants.map((v) => v.id)));
      setActiveVariantId(startingVariants[0].id);
      setCreativeAssets(c.creativeAssets ?? []);
      // Prefer a network that actually has a working ad list — TikTok's sidebar renders a
      // "coming soon" placeholder instead of the campaign's ads, so if TikTok's variants
      // simply happened to be generated first, defaulting to it here would hide real,
      // ready-to-review Meta/Google ads behind that placeholder on first load.
      const firstUsableVariant = startingVariants.find((v) => v.network !== "tiktok") ?? startingVariants[0];
      setNewAdNetwork(firstUsableVariant.network);
    }).catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load campaign"));
  }, [campaignId]);

  useEffect(() => {
    api.listMetaAdAccounts(wsId).then(setAdAccounts).catch(() => {});
    api.listMetaPages(wsId).then(setPages).catch(() => {});
    api.listMetaPixels(wsId).then(setPixels).catch(() => {});
    // Track when the Google-customers fetch has settled so the "not connected" banner only shows
    // once we KNOW the list is empty — not during the in-flight window (which would flash it for
    // every connected user on load).
    setGoogleAccountsLoaded(false);
    api.listGoogleCustomers(wsId).then(setCustomers).catch(() => {}).finally(() => setGoogleAccountsLoaded(true));
    api.listGoogleConversionActions(wsId).then(setConversionActions).catch(() => {});
  }, [wsId]);

  useEffect(() => { if (!adAccountId && adAccounts.length === 1) setAdAccountId(adAccounts[0].id); }, [adAccounts, adAccountId]);
  useEffect(() => { if (!pageId && pages.length === 1) setPageId(pages[0].id); }, [pages, pageId]);
  useEffect(() => { if (!pixelId && pixels.length === 1) setPixelId(pixels[0].id); }, [pixels, pixelId]);
  useEffect(() => { if (!customerId && customers.length === 1) setCustomerId(customers[0].id); }, [customers, customerId]);
  useEffect(() => { if (!conversionActionId && conversionActions.length === 1) setConversionActionId(conversionActions[0].id); }, [conversionActions, conversionActionId]);

  useEffect(() => {
    if (!pageId) { setInstagramAccounts([]); return; }
    api.listMetaInstagramAccounts(wsId, pageId).then((list) => {
      setInstagramAccounts(list);
      setInstagramAccountId((current) => current || (list.length === 1 ? list[0].id : current));
    }).catch(() => setInstagramAccounts([]));
  }, [wsId, pageId]);

  useEffect(() => {
    api.getEphemeralReachEstimate(wsId, { locations }).then(setReach).catch(() => setReach(null));
  }, [wsId, locations]);

  useEffect(() => () => { Object.values(pollHandles.current).forEach(clearInterval); }, []);

  // Surfaced once as a single explanatory banner instead of a bare "(mock)" suffix repeated
  // on every dropdown value with no context on why, or what to do about it.
  const usingMockMetaAccounts = [...adAccounts, ...pages, ...pixels].some((a) => a.name?.includes("(mock)"));

  const activeVariant = variants.find((v) => v.id === activeVariantId) ?? variants[0];
  const activeCreative = activeVariant?.creative ?? emptyCreative();
  // Sidebar is scoped to whichever network is selected above it — "Ad 1" means the first ad
  // *within that network*, matching how the reference design numbers each platform's ads from 1.
  const visibleVariants = variants.filter((v) => v.network === newAdNetwork);
  const activeIndex = visibleVariants.findIndex((v) => v.id === activeVariant?.id);
  const networkCounts = {
    meta: variants.filter((v) => v.network === "meta").length,
    google: variants.filter((v) => v.network === "google").length,
    tiktok: variants.filter((v) => v.network === "tiktok").length,
  };
  const selectedPage = pages.find((p) => p.id === pageId);
  const includedVariants = variants.filter((v) => includedVariantIds.has(v.id));
  const networksInUse = new Set(includedVariants.map((v) => v.network));
  const networkReady = (n: CampaignVariant["network"]) => (n === "google" ? Boolean(customerId) : n === "tiktok" ? true : Boolean(adAccountId && pageId));
  const networkLabel = (n: CampaignVariant["network"]) => (n === "meta" ? "Meta" : n === "google" ? "Google" : "TikTok");
  const includedCountFor = (n: CampaignVariant["network"]) => includedVariants.filter((v) => v.network === n).length;

  // A network with included ads but no config isn't a hard blocker: instead of forcing the user
  // to hunt down and uncheck those ads on another tab, we auto-skip that network at publish time
  // and launch only the networks that ARE configured. `publishableVariants` is what actually gets
  // sent — the backend launches only the networks present in the variant list (campaignOrchestrator
  // .launchCampaign), so dropping unconfigured-network ads here means Publish targets Meta-only when
  // Google isn't set up, and vice-versa.
  const publishableVariants = includedVariants.filter((v) => networkReady(v.network));
  const publishableNetworks = [...networksInUse].filter((n) => networkReady(n));
  const skippedNetworks = [...networksInUse].filter((n) => !networkReady(n));

  // Named so the Publish button can show exactly what's missing instead of a single
  // disabled state with no visible explanation (previously only a hover tooltip). These are HARD
  // blockers — things no partial-publish can proceed without. Per-network config gaps are NOT here;
  // they surface as the non-blocking `skippedNetworks` notice below.
  const publishBlockers: string[] = [];
  if (networksInUse.size === 0) publishBlockers.push("Include at least one ad using the checkboxes on the left");
  else if (publishableVariants.length === 0) publishBlockers.push(`Configure at least one network above to publish (${skippedNetworks.map(networkLabel).join(", ")} not set up yet)`);
  if (!activeCreative.headline.trim()) publishBlockers.push("Add a headline for the active ad in Ad Copy");
  if (creativeAssets.length === 0) publishBlockers.push("Add at least one ad creative (AI-generate or upload)");
  const canPublish = publishBlockers.length === 0;

  function updateActiveVariant(patch: Partial<AdCreative>) {
    if (!activeVariant) return;
    setVariants((prev) => prev.map((v) => (v.id === activeVariant.id ? { ...v, creative: { ...v.creative, ...patch } } : v)));
  }

  function addVariant() {
    const next = emptyVariant(variants.length, newAdNetwork);
    setVariants((prev) => [...prev, next]);
    setIncludedVariantIds((prev) => new Set(prev).add(next.id));
    setActiveVariantId(next.id);
  }

  // Switching the network filter also moves the editor to that network's first ad, so the
  // right-hand panels never show an ad that's no longer visible in the (now-filtered) sidebar.
  function handleNetworkFilterChange(network: CampaignVariant["network"]) {
    setNewAdNetwork(network);
    const firstInNetwork = variants.find((v) => v.network === network);
    if (firstInNetwork) setActiveVariantId(firstInNetwork.id);
  }

  function toggleVariantIncluded(id: string) {
    setIncludedVariantIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function addLocation() {
    const v = locationInput.trim();
    if (v && !locations.includes(v)) { setLocations([...locations, v]); setLocationInput(""); }
  }

  function setHeadlineAt(index: number, value: string) {
    const list = [...getHeadlines(activeCreative)];
    list[index] = value;
    updateActiveVariant({ headlines: list, headline: list[0] });
  }

  function addHeadlineSlot() {
    const list = getHeadlines(activeCreative);
    if (list.length >= MAX_COPY_VARIANTS) return;
    updateActiveVariant({ headlines: [...list, ""] });
  }

  function removeHeadlineAt(index: number) {
    const list = getHeadlines(activeCreative).filter((_, i) => i !== index);
    const safe = list.length ? list : [""];
    updateActiveVariant({ headlines: safe, headline: safe[0] });
  }

  function setPrimaryTextAt(index: number, value: string) {
    const list = [...getPrimaryTexts(activeCreative)];
    list[index] = value;
    updateActiveVariant({ primaryTexts: list, body: list[0] });
  }

  function addPrimaryTextSlot() {
    const list = getPrimaryTexts(activeCreative);
    if (list.length >= MAX_COPY_VARIANTS) return;
    updateActiveVariant({ primaryTexts: [...list, ""] });
  }

  function removePrimaryTextAt(index: number) {
    const list = getPrimaryTexts(activeCreative).filter((_, i) => i !== index);
    const safe = list.length ? list : [""];
    updateActiveVariant({ primaryTexts: safe, body: safe[0] });
  }

  async function handleAiSuggestCopy() {
    setActionError(null);
    setSuggesting(true);
    try {
      const variations = await api.generateCreativeVariations({
        headline: activeCreative.headline || "Our product",
        body: activeCreative.body || "Discover what makes us different.",
        callToAction: activeCreative.callToAction || "Learn More",
      });
      const headlines = [...getHeadlines(activeCreative)];
      const primaryTexts = [...getPrimaryTexts(activeCreative)];
      for (const v of variations) {
        if (headlines.length < MAX_COPY_VARIANTS && v.headline && !headlines.includes(v.headline)) headlines.push(v.headline);
        if (primaryTexts.length < MAX_COPY_VARIANTS && v.body && !primaryTexts.includes(v.body)) primaryTexts.push(v.body);
      }
      updateActiveVariant({ headlines, primaryTexts, headline: headlines[0], body: primaryTexts[0] });
      setCopyExpanded(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "AI suggestion failed");
    } finally {
      setSuggesting(false);
    }
  }

  function pollGenJob(jobId: string) {
    pollHandles.current[jobId] = setInterval(async () => {
      try {
        const updated = await api.getGenerationJob(jobId);
        setGenJobs((prev) => prev.map((j) => (j.id === jobId ? updated : j)));
        if (updated.status === "done") {
          clearInterval(pollHandles.current[jobId]);
          delete pollHandles.current[jobId];
          if (updated.result) {
            setCreativeAssets((prev) => {
              if (prev.length >= MAX_CREATIVES) return prev;
              const url = updated.result!.videoUrl ?? updated.result!.imageUrl;
              return [...prev, { id: updated.result!.imageAssetId, url, type: updated.result!.videoUrl ? "video" : "image", source: "ai" }];
            });
          }
        } else if (updated.status === "failed") {
          clearInterval(pollHandles.current[jobId]);
          delete pollHandles.current[jobId];
          setActionError(updated.error ?? "Creative generation failed — try again.");
        }
      } catch {
        clearInterval(pollHandles.current[jobId]);
        delete pollHandles.current[jobId];
        setActionError("Lost track of the generation job — try again.");
      }
    }, POLL_INTERVAL_MS);
  }

  const isGenerating = genJobs.some((j) => j.status === "queued" || j.status === "running");

  async function handleAiGenerateCreative() {
    if (!campaign || creativeAssets.length >= MAX_CREATIVES || isGenerating) return;
    setActionError(null);
    try {
      const job = await api.createGenerationJob(wsId, {
        businessId: campaign.businessId,
        productUrl: finalUrl.trim() || undefined,
        prompt: finalUrl.trim() ? undefined : (activeCreative.headline || "A compelling product ad creative"),
        wantVideo: false,
        aspectRatio: genAspectRatio,
        language: genLanguage,
        quality: genQuality,
      });
      setGenJobs((prev) => [job, ...prev]);
      pollGenJob(job.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start generation");
    }
  }

  function handleUploadClick() {
    if (creativeAssets.length >= MAX_CREATIVES) return;
    fileInputRef.current?.click();
  }

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || creativeAssets.length >= MAX_CREATIVES) return;

    // Checked here so an oversized file is rejected instantly with its actual size, instead of
    // spending a full upload to come back as an opaque 413. The ceiling is derived, not arbitrary:
    // the file is sent base64-encoded inside a JSON body, base64 inflates by ~33%, and the API caps
    // JSON at 10mb — so ~7MB of raw file is the most that can fit. Raising this means raising
    // express.json's limit in apps/api/src/index.ts AND client_max_body_size in docker/nginx.conf.
    if (file.size > MAX_UPLOAD_BYTES) {
      const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)}MB`;
      setActionError(`"${file.name}" is ${mb(file.size)} — the limit is ${mb(MAX_UPLOAD_BYTES)}. Please compress it or pick a smaller file.`);
      return;
    }

    const isVideo = file.type.startsWith("video");
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      const base64 = dataUrl.split(",")[1] ?? "";
      if (!base64) return;
      try {
        const asset = await api.uploadAsset(wsId, { name: file.name, type: isVideo ? "video" : "image", mimeType: file.type, dataBase64: base64 });
        setCreativeAssets((prev) => (prev.length >= MAX_CREATIVES ? prev : [...prev, { id: asset.id, url: asset.url, type: isVideo ? "video" : "image", source: "upload" }]));
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Upload failed");
      }
    };
    reader.readAsDataURL(file);
  }

  function useAssetForActiveVariant(asset: CreativeAssetRef) {
    updateActiveVariant(asset.type === "video" ? { videoUrl: asset.url, imageUrl: undefined } : { imageUrl: asset.url, videoUrl: undefined });
  }

  function removeCreativeAsset(id: string) {
    setCreativeAssets((prev) => prev.filter((a) => a.id !== id));
  }

  // `forPublish` drops ads on networks that aren't configured yet (see publishableVariants) so a
  // Meta-only publish doesn't drag along un-launchable Google ads. Save-draft keeps every included
  // ad so nothing the user checked is silently lost between sessions.
  function buildPatch(forPublish = false) {
    const included = variants.filter((v) => includedVariantIds.has(v.id));
    const selected = forPublish ? included.filter((v) => networkReady(v.network)) : included;
    return {
      dailyBudgetCents: Math.max(1, Math.round((parseFloat(dailyBudget) || 0) * 100)),
      budgetMode,
      conversionEvent,
      finalUrl: finalUrl.trim() || undefined,
      startDate: startDate || undefined,
      locations,
      advantagePlus,
      metaAdAccountId: adAccountId || undefined,
      pageId: pageId || undefined,
      instagramAccountId: instagramAccountId || undefined,
      pixelId: pixelId || undefined,
      googleCustomerId: customerId || undefined,
      googleConversionActionId: conversionActionId || undefined,
      variants: selected.length ? selected : variants,
      creativeAssets,
    };
  }

  async function handleSaveDraft() {
    if (!campaign) return;
    setSaving(true);
    setActionError(null);
    setSaveConfirmed(false);
    try {
      const patch = buildPatch();
      const updated = await api.updateCampaign(campaign.id, patch);
      setCampaign(updated);

      const draftData = {
        campaignId: updated.id,
        businessId: updated.businessId,
        name: updated.name,
        status: updated.status,
        networks: updated.networks,
        strategyId: updated.strategyId,
        dailyBudgetCents: updated.dailyBudgetCents,
        conversionEvent: updated.conversionEvent,
        finalUrl: updated.finalUrl,
        startDate: updated.startDate,
        locations: updated.locations,
        advantagePlus: updated.advantagePlus,
        metaAdAccountId: updated.metaAdAccountId,
        pageId: updated.pageId,
        instagramAccountId: updated.instagramAccountId,
        pixelId: updated.pixelId,
        googleCustomerId: updated.googleCustomerId,
        googleConversionActionId: updated.googleConversionActionId,
        variants: updated.variants,
        creativeAssets: updated.creativeAssets,
      };
      const existingDrafts = await api.listDrafts(wsId).catch(() => []);
      const existing = existingDrafts.find((d) => (d.data as { campaignId?: string })?.campaignId === campaign.id);
      if (existing) {
        await api.updateDraft(existing.id, { name: campaign.name, data: draftData });
      } else {
        await api.createDraft(wsId, { name: campaign.name, type: "campaign", data: draftData });
      }

      setSaveConfirmed(true);
      setTimeout(() => setSaveConfirmed(false), 3000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save draft");
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish() {
    if (!campaign) return;
    setPublishing(true);
    setActionError(null);
    try {
      await api.updateCampaign(campaign.id, buildPatch(true));
      const launched = await api.launchCampaign(campaign.id, wsId);
      setCampaign(launched);
      navigate(`/campaigns/${campaign.id}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to publish");
    } finally {
      setPublishing(false);
    }
  }

  if (loadError) return <div className="campaign-builder"><p className="error">{loadError}</p></div>;
  if (!campaign) return <div className="campaign-builder"><p className="muted-text">Loading campaign…</p></div>;

  const headlines = getHeadlines(activeCreative);
  const primaryTexts = getPrimaryTexts(activeCreative);
  const visibleHeadlines = copyExpanded ? headlines : headlines.slice(0, 1);
  const visiblePrimaryTexts = copyExpanded ? primaryTexts : primaryTexts.slice(0, 1);

  return (
    <div className="campaign-builder">
      {usingMockMetaAccounts && activeVariant?.network !== "google" && activeVariant?.network !== "tiktok" && (
        <p className="demo-data-banner">
          These are placeholder demo accounts — no Meta Business account is connected yet. Connect one in Settings to launch real campaigns.
        </p>
      )}

      {/* Google customers came back empty AFTER the fetch settled → no Google Ads connection for this
          workspace (common for CRM-SSO users whose Google Ads wasn't connected in the CRM). Say so
          plainly instead of leaving the user staring at an empty "Select customer" dropdown. */}
      {activeVariant?.network === "google" && googleAccountsLoaded && customers.length === 0 && (
        <p className="demo-data-banner">
          No Google Ads account is connected for this workspace, so there are no customers to select — these Google ads will be skipped at publish.
          Connect Google Ads in Settings → Advertising Accounts (or, if you came from the CRM, connect Google Ads there and sign in again) to launch them.
        </p>
      )}

      <div className="campaign-builder-topbar">
        {activeVariant?.network === "google" ? (
          <>
            <DropdownField label="Google Ads Customer ID" options={customers.map((c) => ({ value: c.id, label: c.name }))} selected={customerId ? [customerId] : []} onChange={([v]) => setCustomerId(v)} placeholder="Select customer" emptyHint="Connect a Google Ads account in Settings to load customers." />
            <DropdownField label="Conversion Action" options={conversionActions.map((a) => ({ value: a.id, label: a.name }))} selected={conversionActionId ? [conversionActionId] : []} onChange={([v]) => setConversionActionId(v)} placeholder="Select conversion action" emptyHint="Connect a Google Ads account in Settings to load conversion actions." />
          </>
        ) : activeVariant?.network === "tiktok" ? (
          <p className="muted-text">TikTok Ads — launches through a server-configured access token, no per-workspace account selection needed here.</p>
        ) : (
          <>
            <DropdownField label="Meta Ad Account" options={adAccounts.map((a) => ({ value: a.id, label: a.name }))} selected={adAccountId ? [adAccountId] : []} onChange={([v]) => setAdAccountId(v)} placeholder="Select ad account" />
            <DropdownField label="Page" options={pages.map((p) => ({ value: p.id, label: p.name }))} selected={pageId ? [pageId] : []} onChange={([v]) => setPageId(v)} placeholder="Select Page" />
            <DropdownField label="Instagram Account" options={instagramAccounts.map((i) => ({ value: i.id, label: i.username }))} selected={instagramAccountId ? [instagramAccountId] : []} onChange={([v]) => setInstagramAccountId(v)} placeholder="Optional" />
            <DropdownField label="Pixel" options={pixels.map((p) => ({ value: p.id, label: p.name }))} selected={pixelId ? [pixelId] : []} onChange={([v]) => setPixelId(v)} placeholder="Select pixel" />
          </>
        )}
      </div>

      <div className="campaign-builder-header">
        <h2 className="campaign-builder-title">{campaign.name}</h2>
        <div className="campaign-builder-meta-chips">
          {campaign.networks.map((n) => (
            <span key={n} className={`campaign-builder-network-chip ${n}`}>{n === "meta" ? "Meta Ads" : n === "google" ? "Google Ads" : "TikTok"}</span>
          ))}
          <span className="campaign-builder-budget-chip">{formatDaily(campaign.dailyBudgetCents)}</span>
          <span className="campaign-builder-variant-chip">{variants.length} ad{variants.length !== 1 ? "s" : ""}</span>
        </div>
      </div>

      <div className="campaign-builder-main">
        <aside className="campaign-builder-sidebar card">
          <select
            className="campaign-builder-network-filter"
            value={newAdNetwork}
            onChange={(e) => handleNetworkFilterChange(e.target.value as CampaignVariant["network"])}
          >
            <option value="meta">Meta ({networkCounts.meta})</option>
            <option value="google">Google ({networkCounts.google})</option>
            <option value="tiktok">TikTok ({networkCounts.tiktok})</option>
          </select>

          {visibleVariants.length === 0 ? (
            <p className="muted-text campaign-builder-tiktok-note">No {newAdNetwork === "meta" ? "Meta" : newAdNetwork === "google" ? "Google" : "TikTok"} ads yet.</p>
          ) : (
            visibleVariants.slice(0, MAX_ADS_SHOWN).map((v, i) => (
              <div key={v.id} className={`campaign-builder-variant-item ${v.id === activeVariant?.id ? "active" : ""}`}>
                <input type="checkbox" checked={includedVariantIds.has(v.id)} onChange={() => toggleVariantIncluded(v.id)} />
                <button type="button" className="campaign-builder-variant-label" onClick={() => setActiveVariantId(v.id)}>
                  Ad {i + 1}{v.creative.headline ? ` — ${v.creative.headline.slice(0, 22)}` : ""}
                </button>
              </div>
            ))
          )}
          {visibleVariants.length > MAX_ADS_SHOWN && (
            <button type="button" className="btn btn-secondary btn-sm btn-full mt-2" onClick={addVariant}>
              All {visibleVariants.length} ads
            </button>
          )}
          {visibleVariants.length <= MAX_ADS_SHOWN && (
            <button type="button" className="btn btn-secondary btn-sm btn-full mt-2" onClick={addVariant}>+ Add Ad</button>
          )}
        </aside>

        <div className="campaign-builder-center">
          <section className="card ad-preview-card">
            <div className="ad-preview-card-header">
              <h2>Ad Preview</h2>
              <span className="ad-preview-badge">Ad {activeIndex + 1}</span>
            </div>
            {activeVariant?.network === "google" ? (
              <div className="ad-preview-search">
                <div className="ad-preview-search-advertiser">
                  <span className="ad-preview-search-favicon" aria-hidden="true">{(finalUrl || campaign.name).replace(/^https?:\/\//, "").charAt(0).toUpperCase()}</span>
                  <span className="ad-preview-search-brand">{selectedPage?.name ?? campaign.name}</span>
                </div>
                <div className="ad-preview-search-domain-row">
                  <span className="ad-preview-search-badge">Ad</span>
                  <span aria-hidden="true">·</span>
                  <span className="ad-preview-search-url">{(finalUrl || "https://example.com").replace(/^https?:\/\//, "")}</span>
                  <span className="ad-preview-search-caret" aria-hidden="true">▾</span>
                </div>
                <div className="ad-preview-search-headline">{headlines.filter(Boolean).slice(0, 3).join(" | ") || "Your headline"}</div>
                <p className="ad-preview-search-description">{primaryTexts[0] || "Your description will show here"}</p>
                {headlines.filter(Boolean).length > 1 && (
                  <div className="ad-preview-search-sitelinks">
                    {headlines.filter(Boolean).slice(1, 5).map((h, i) => (
                      <span key={i} className="ad-preview-search-sitelink">{h}</span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="ad-preview-post">
                <div className="ad-preview-post-header">
                  <div className="ad-preview-avatar">{(selectedPage?.name ?? campaign.name).slice(0, 2).toUpperCase()}</div>
                  <div className="ad-preview-post-meta">
                    <strong>{selectedPage?.name ?? campaign.name}</strong>
                    <span className="ad-preview-sponsored-row muted-text">Sponsored <span aria-hidden="true">· 🌐</span></span>
                  </div>
                  <span className="ad-preview-post-menu" aria-hidden="true">•••</span>
                </div>
                {primaryTexts[0] && (
                  <p className="ad-preview-text">
                    {primaryTexts[0].length > 125 ? primaryTexts[0].slice(0, 125).trimEnd() + "… " : primaryTexts[0]}
                    {primaryTexts[0].length > 125 && <span className="ad-preview-see-more">See more</span>}
                  </p>
                )}
                <div className="ad-preview-media">
                  {activeCreative.videoUrl ? (
                    <video src={activeCreative.videoUrl} controls />
                  ) : activeCreative.imageUrl ? (
                    <img src={activeCreative.imageUrl} alt="" />
                  ) : creativeAssets.length > 0 ? (
                    <img src={creativeAssets[0].url} alt="" />
                  ) : (
                    <div className="ad-preview-media-empty">Generate or upload a creative</div>
                  )}
                </div>
                <div className="ad-preview-footer">
                  <div className="ad-preview-footer-headline">
                    <span className="ad-preview-footer-domain">{(finalUrl || "example.com").replace(/^https?:\/\//, "").split("/")[0]}</span>
                    <strong>{headlines[0] || "Your headline"}</strong>
                  </div>
                  <button type="button" className="ad-preview-footer-cta" disabled>{activeCreative.callToAction}</button>
                </div>
                <div className="ad-preview-social-row">
                  <span><span className="ad-preview-social-icon" aria-hidden="true">👍</span> Like</span>
                  <span><span className="ad-preview-social-icon" aria-hidden="true">💬</span> Comment</span>
                  <span><span className="ad-preview-social-icon" aria-hidden="true">↗</span> Share</span>
                </div>
              </div>
            )}
          </section>

          <section className="card settings-card">
            <h2>Settings</h2>
            <div className="wizard-form mt-2">
              <div className="form-row-2">
                <label>
                  Conversion Event
                  <select value={conversionEvent} onChange={(e) => setConversionEvent(e.target.value)}>
                    {CONVERSION_EVENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
                <label>
                  Daily Budget ({symbol})
                  <input type="number" min="1" value={dailyBudget} onChange={(e) => setDailyBudget(e.target.value)} />
                </label>
              </div>
              <div className="form-row-2">
                <label>
                  Schedule
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                </label>
                <label>
                  Final URL
                  <input type="text" placeholder="https://example.com/" value={finalUrl} onChange={(e) => setFinalUrl(e.target.value)} />
                </label>
              </div>
              <div className="settings-locations-row">
                <div className="settings-locations-field">
                  <span className="settings-field-label">Locations</span>
                  <div className="tags-input-row">
                    <input type="text" value={locationInput} onChange={(e) => setLocationInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLocation(); } }} placeholder="e.g. New York, London" />
                    <button type="button" className="btn btn-accent btn-sm location-add-btn" onClick={addLocation}>+</button>
                  </div>
                  <div className="audience-pills-row mt-1">
                    {locations.map((loc) => (
                      <span key={loc} className="audience-pill-saved">
                        {loc}
                        <button type="button" className="audience-pill-remove" onClick={() => setLocations(locations.filter((l) => l !== loc))}>×</button>
                      </span>
                    ))}
                  </div>
                </div>
                <div className="settings-reach-field">
                  <label className="ai-generate-checkbox-field">
                    <input type="checkbox" checked={advantagePlus} onChange={(e) => setAdvantagePlus(e.target.checked)} />
                    <span>Advantage+ (auto-optimize)</span>
                  </label>
                  <label className="ai-generate-checkbox-field" title="Campaign Budget Optimization: one budget on the campaign, distributed across audiences by Meta (instead of a fixed budget per audience).">
                    <input type="checkbox" checked={budgetMode === "CBO"} onChange={(e) => setBudgetMode(e.target.checked ? "CBO" : "ABO")} />
                    <span>Campaign Budget Optimization (Advantage Campaign Budget)</span>
                  </label>
                  <div className="reach-estimation-inline mt-2">
                    <div className="reach-estimation-inline-header">
                      <span className="reach-label">Reach</span>
                      <span className="reach-value">{reach ? formatReach(reach) : "..."}</span>
                    </div>
                    <div className="reach-gauge mt-1">
                      <div className="reach-gauge-bar" style={{ width: `${reach ? Math.min(100, Math.max(10, (reach.usersLowerBound / 5_000_000) * 100)) : 30}%` }} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="campaign-builder-right">
          <section className="card">
            <div className="ad-copy-header">
              <h2>Ad Copy</h2>
              <button type="button" className="btn btn-secondary btn-sm" onClick={handleAiSuggestCopy} disabled={suggesting}>
                {suggesting ? "..." : "AI Suggest"}
              </button>
            </div>
            <div className="wizard-form mt-2">
              <label className="wizard-form-label-row">Headlines <span className="muted-text">{headlines.length}/{MAX_COPY_VARIANTS}</span></label>
              {visibleHeadlines.map((h, i) => (
                <div className="tags-input-row" key={`headline-${i}`}>
                  <input type="text" value={h} maxLength={40} onChange={(e) => setHeadlineAt(i, e.target.value)} placeholder={`Headline ${i + 1}`} />
                  {headlines.length > 1 && <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeHeadlineAt(i)}>×</button>}
                </div>
              ))}
              {visibleHeadlines.length > 0 && visibleHeadlines[0] && (
                <div className={`ad-copy-char-count${visibleHeadlines[0].length > 35 ? visibleHeadlines[0].length > 40 ? " over" : " warning" : ""}`}>{visibleHeadlines[0].length}/40</div>
              )}
              {copyExpanded && headlines.length < MAX_COPY_VARIANTS && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={addHeadlineSlot}>+ Headline</button>
              )}

              <label className="wizard-form-label-row mt-3">Primary text <span className="muted-text">{primaryTexts.length}/{MAX_COPY_VARIANTS}</span></label>
              {visiblePrimaryTexts.map((t, i) => (
                <div className="tags-input-row" key={`text-${i}`}>
                  <textarea rows={2} value={t} onChange={(e) => setPrimaryTextAt(i, e.target.value)} placeholder={`Primary text ${i + 1}`} />
                  {primaryTexts.length > 1 && <button type="button" className="btn btn-secondary btn-sm" onClick={() => removePrimaryTextAt(i)}>×</button>}
                </div>
              ))}
              {visiblePrimaryTexts.length > 0 && visiblePrimaryTexts[0] && (
                <div className={`ad-copy-char-count${visiblePrimaryTexts[0].length > 110 ? visiblePrimaryTexts[0].length > 125 ? " over" : " warning" : ""}`}>{visiblePrimaryTexts[0].length}/125</div>
              )}
              {copyExpanded && primaryTexts.length < MAX_COPY_VARIANTS && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={addPrimaryTextSlot}>+ Text</button>
              )}

              {(headlines.length > 1 || primaryTexts.length > 1) && (
                <button type="button" className="btn btn-secondary btn-sm mt-2" onClick={() => setCopyExpanded((v) => !v)}>
                  {copyExpanded ? "Show less" : `Show all (${headlines.length + primaryTexts.length} variants)`}
                </button>
              )}

              <label className="mt-3">
                Call to Action
                <select value={activeCreative.callToAction} onChange={(e) => updateActiveVariant({ callToAction: e.target.value })}>
                  {CTA_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </div>
          </section>

          <section className="card ad-creatives-card">
            <h2>Creatives <span className="muted-text">{creativeAssets.length}/{MAX_CREATIVES}</span></h2>

            <div className="creative-gen-options mt-2">
              <label>
                Ratio
                <select value={genAspectRatio} onChange={(e) => setGenAspectRatio(e.target.value as ImageAspectRatio)} disabled={isGenerating}>
                  <option value="square">1:1</option>
                  <option value="portrait">9:16</option>
                  <option value="landscape">16:9</option>
                </select>
              </label>
              <label>
                Language
                <select value={genLanguage} onChange={(e) => setGenLanguage(e.target.value)} disabled={isGenerating}>
                  <option value="English">EN</option>
                  <option value="Spanish">ES</option>
                  <option value="French">FR</option>
                  <option value="German">DE</option>
                  <option value="Portuguese">PT</option>
                  <option value="Hindi">HI</option>
                  <option value="Japanese">JA</option>
                  <option value="Arabic">AR</option>
                </select>
              </label>
              <label>
                Quality
                <select value={genQuality} onChange={(e) => setGenQuality(e.target.value as ImageQuality)} disabled={isGenerating}>
                  <option value="standard">Std</option>
                  <option value="high">HD</option>
                </select>
              </label>
            </div>

            <div className="creative-asset-actions mt-2">
              <button type="button" className="btn btn-primary btn-sm btn-full" onClick={handleAiGenerateCreative} disabled={creativeAssets.length >= MAX_CREATIVES || isGenerating}>{isGenerating ? "Generating…" : "AI Generate"}</button>
              <button type="button" className="btn btn-secondary btn-sm btn-full" onClick={handleUploadClick} disabled={creativeAssets.length >= MAX_CREATIVES}>Upload</button>
              <input ref={fileInputRef} type="file" accept="image/*,video/*" hidden onChange={handleFileSelected} />
            </div>

            {isGenerating && (
              <div className="creative-generating-row mt-2">
                <span className="creative-generating-spinner" aria-hidden="true" />
                <p className="muted-text">Generating creative…</p>
              </div>
            )}

            {creativeAssets.length > 0 ? (
              <div className="creative-asset-grid mt-2">
                {creativeAssets.map((asset) => (
                  <div key={asset.id} className="creative-asset-thumb" onClick={() => useAssetForActiveVariant(asset)}>
                    {asset.type === "video" ? <video src={asset.url} /> : <img src={asset.url} alt="" />}
                    <button type="button" className="creative-asset-remove" onClick={(e) => { e.stopPropagation(); removeCreativeAsset(asset.id); }}>×</button>
                  </div>
                ))}
              </div>
            ) : !isGenerating && (
              <div className="creative-empty-state mt-2">
                <span className="creative-empty-state-icon">🖼</span>
                <p>No creatives yet. AI Generate or upload images/videos for your ads.</p>
              </div>
            )}
          </section>
        </div>
      </div>

      {actionError && <p className="error mt-3">{actionError}</p>}

      {!canPublish && (
        <div className="publish-blockers mt-3">
          <strong>Before you can publish:</strong>
          <ul>
            {publishBlockers.map((b) => <li key={b}>{b}</li>)}
          </ul>
        </div>
      )}

      {/* Non-blocking: at least one network is publishable, but some included ads are on a network
          that isn't set up. Tell the user those will be skipped rather than silently dropping them. */}
      {canPublish && skippedNetworks.length > 0 && (
        <div className="publish-notice mt-3">
          Publishing to {publishableNetworks.map(networkLabel).join(", ")} only.{" "}
          {skippedNetworks.map(networkLabel).join(", ")} {skippedNetworks.length === 1 ? "isn’t" : "aren’t"} connected yet, so{" "}
          {skippedNetworks.map((n) => `${includedCountFor(n)} ${networkLabel(n)} ad${includedCountFor(n) === 1 ? "" : "s"}`).join(" and ")}{" "}
          will be skipped. Connect {skippedNetworks.length === 1 ? "it" : "them"} above to include {skippedNetworks.length === 1 ? "it" : "them"}.
        </div>
      )}

      {saveConfirmed && <p className="save-confirmed mt-3">✓ Draft saved</p>}

      <div className="campaign-builder-footer">
        <button type="button" className="btn btn-secondary" onClick={() => navigate(-1)}>Previous</button>
        <span className="campaign-builder-footer-note campaign-builder-footer-note-disabled">
          No ad account? Publish with polluxa account (coming soon)
        </span>
        <div className="campaign-builder-footer-actions">
          <button type="button" className="btn btn-secondary" onClick={handleSaveDraft} disabled={saving}>{saving ? "Saving…" : "Save draft"}</button>
          <button type="button" className="btn btn-primary" onClick={handlePublish} disabled={publishing || !canPublish}>
            {publishing ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>
    </div>
  );
}
