import { randomUUID } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { llm, runText } from "../../infra/llmClient.js";
import { logger } from "../logger/logger.js";

export interface Draft {
  id: string;
  workspaceId: string;
  name: string;
  type: "campaign" | "ad_set" | "ad";
  status: "draft" | "review" | "scheduled" | "published";
  data: Record<string, unknown>;
  aiRecommendation?: string;
  score?: number;
  scheduledAt?: string;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Where this draft actually lives, so the client can route publish/edit/delete to the right
   * backend. "draft" = a row in the Draft table (the CampaignBuilder "Save as draft" flow).
   * "campaign" = a Campaign row with status "draft" (the Campaign Generator flow, which never wrote
   * to the Draft table) surfaced here read-only so unpublished campaigns aren't invisible on /drafts.
   * Absent is treated as "draft" for backward compatibility with already-persisted rows.
   */
  origin?: "draft" | "campaign";
}

async function generateAiRecommendation(name: string, type: Draft["type"], data: Record<string, unknown>): Promise<string | undefined> {
  if (!llm) return undefined;
  try {
    const reply = await runText({
      maxTokens: 220,
      system: "You are an ad strategist reviewing a draft campaign before launch. In 2-3 sentences, give one concrete, specific recommendation to improve performance (budget, targeting, creative, or timing). Be direct and reference real numbers/details from the draft when present. No preamble.",
      messages: [{ role: "user", content: `Draft name: ${name}\nType: ${type}\nDetails: ${JSON.stringify(data)}` }],
    });
    return reply?.trim() || undefined;
  } catch (err) {
    logger.error("Failed to generate draft AI recommendation", err);
    return undefined;
  }
}

async function save(d: Draft): Promise<void> {
  await prisma.draft.upsert({
    where: { id: d.id },
    create: { id: d.id, workspaceId: d.workspaceId, data: d as any, createdAt: new Date(d.createdAt), updatedAt: new Date(d.updatedAt) },
    update: { data: d as any, updatedAt: new Date(d.updatedAt) },
  });
}

export async function listDrafts(workspaceId: string): Promise<Draft[]> {
  const rows = await prisma.draft.findMany({ where: { workspaceId }, orderBy: { updatedAt: "desc" } });
  const savedDrafts: Draft[] = rows.map((r) => ({ ...(r.data as unknown as Draft), origin: "draft" }));

  // Also surface unpublished CAMPAIGNS (Campaign rows with status "draft") here. The Campaign
  // Generator writes Campaign rows directly and never touched the Draft table, so those drafts were
  // invisible on /drafts even though they showed on /campaigns. Merge them read-only, tagged
  // origin:"campaign" so the client routes publish/edit/delete to the campaign endpoints instead of
  // the Draft ones. Matched by the workspaceId column OR via the workspace's businesses, since a
  // Campaign's workspaceId column is only reliably set once launched (see schema.prisma) — a draft
  // built before launch may carry only businessId.
  const businesses = await prisma.business.findMany({ where: { workspaceId }, select: { id: true } });
  const businessIds = businesses.map((b) => b.id);
  const campaignRows = await prisma.campaign.findMany({
    where: { OR: [{ workspaceId }, ...(businessIds.length ? [{ businessId: { in: businessIds } }] : [])] },
    orderBy: { updatedAt: "desc" },
  });

  const campaignDrafts: Draft[] = campaignRows
    .map((row) => ({ row, c: row.data as any }))
    .filter(({ c }) => c?.status === "draft")
    .map(({ row, c }) => ({
      // Distinct id namespace so a campaign-origin draft never collides with a Draft-table id, and
      // the client can strip the prefix to recover the campaignId for campaign-scoped actions.
      id: `campaign:${row.id}`,
      workspaceId,
      name: c.name ?? "Untitled campaign",
      type: "campaign" as const,
      status: "draft" as const,
      // The Drafts UI reads campaignId/dailyBudgetCents/variants/creativeAssets/finalUrl off `data`
      // (see draftBudget/draftAudience/draftCreativeCount) — the campaign JSON already has these, and
      // campaignId lets the existing Edit handler deep-link into the builder.
      data: { ...c, campaignId: row.id },
      // Campaign has no createdAt column (it lives in `data`); updatedAt is a real column.
      createdAt: c.createdAt ?? row.updatedAt.toISOString(),
      updatedAt: c.updatedAt ?? row.updatedAt.toISOString(),
      origin: "campaign" as const,
    }));

  // Newest first across both sources.
  return [...savedDrafts, ...campaignDrafts].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function createDraft(workspaceId: string, input: Pick<Draft, "name" | "type" | "data" | "aiRecommendation" | "score" | "scheduledAt">): Promise<Draft> {
  const aiRecommendation = input.aiRecommendation ?? (await generateAiRecommendation(input.name, input.type, input.data));
  const d: Draft = {
    id: randomUUID(),
    workspaceId,
    status: "draft",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...input,
    aiRecommendation,
  };
  await save(d);
  return d;
}

export async function updateDraft(id: string, patch: Partial<Omit<Draft, "id" | "workspaceId" | "createdAt">>): Promise<Draft> {
  // listDrafts surfaces draft-status CAMPAIGNS alongside real Draft rows under a `campaign:<uuid>`
  // id. Those are a read-only view of a Campaign, not Draft rows, so a PATCH here can never find
  // one — and "Draft not found" sent whoever hit it looking for a missing record instead of a
  // mis-routed call. Say what actually happened and where the write belongs.
  if (id.startsWith("campaign:")) {
    throw new Error(
      `${id} is a campaign surfaced on /drafts, not a saved draft — update it through PATCH /campaigns/${id.slice("campaign:".length)} instead.`
    );
  }
  const row = await prisma.draft.findUnique({ where: { id } });
  if (!row) throw new Error("Draft not found");
  const existing = row.data as unknown as Draft;
  const aiRecommendation = patch.aiRecommendation ?? (patch.data ? await generateAiRecommendation(patch.name ?? existing.name, existing.type, patch.data) : existing.aiRecommendation);
  const d: Draft = { ...existing, ...patch, aiRecommendation, updatedAt: new Date().toISOString() };
  await save(d);
  return d;
}

export async function publishDraft(id: string): Promise<Draft> {
  return updateDraft(id, { status: "published", publishedAt: new Date().toISOString() });
}

export async function deleteDraft(id: string): Promise<boolean> {
  const result = await prisma.draft.deleteMany({ where: { id } });
  return result.count > 0;
}

export async function scheduleDraft(id: string, scheduledAt: string): Promise<Draft> {
  return updateDraft(id, { status: "scheduled", scheduledAt });
}

// Ad sets & Ads (mini service here)
export interface AdSet {
  id: string;
  campaignId: string;
  workspaceId?: string;
  name: string;
  status: "active" | "paused" | "draft";
  dailyBudgetCents: number;
  targeting: Record<string, unknown>;
  placements: string[];
  bidStrategy: string;
  startDate?: string;
  endDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Ad {
  id: string;
  adSetId: string;
  workspaceId?: string;
  name: string;
  status: "active" | "paused" | "draft" | "rejected";
  creative: { headline: string; body: string; callToAction: string; imageUrl?: string };
  format: "single_image" | "carousel" | "video" | "collection";
  externalId?: string;
  createdAt: string;
  updatedAt: string;
}

async function saveAdSet(a: AdSet): Promise<void> {
  await prisma.adSet.upsert({
    where: { id: a.id },
    create: { id: a.id, campaignId: a.campaignId, workspaceId: a.workspaceId ?? null, data: a as any, createdAt: new Date(a.createdAt), updatedAt: new Date(a.updatedAt) },
    update: { data: a as any, updatedAt: new Date(a.updatedAt) },
  });
}

async function saveAd(a: Ad): Promise<void> {
  await prisma.ad.upsert({
    where: { id: a.id },
    create: { id: a.id, adSetId: a.adSetId, workspaceId: a.workspaceId ?? null, data: a as any, createdAt: new Date(a.createdAt), updatedAt: new Date(a.updatedAt) },
    update: { data: a as any, updatedAt: new Date(a.updatedAt) },
  });
}

/**
 * Deterministic ad-set/ad IDs for the DRAFT (pre-launch) view. A draft campaign has no
 * prisma.adSet/prisma.ad rows yet (those are written by syncLaunchedHierarchy AT LAUNCH), but the
 * Ads Manager should still show the hierarchy it will publish. We derive it from the campaign's
 * own `variants` JSON: one ad set per distinct (network, audienceName) — the same grouping
 * launchMetaHierarchy uses — and one ad per variant. IDs are stable (derived from campaign + group
 * + variant id) so the ad-set→ad linkage is consistent across the two list calls.
 */
function draftAdSetId(campaignId: string, network: string, audienceName: string): string {
  return `draft-${campaignId}-${network}-${Buffer.from(audienceName).toString("base64url").slice(0, 24)}`;
}

interface CampaignVariantLike {
  id: string;
  network: string;
  status?: string;
  audienceName?: string;
  creative?: { headline?: string; body?: string; callToAction?: string; imageUrl?: string; videoUrl?: string };
}

async function loadCampaignForDerivation(campaignId: string): Promise<{ workspaceId?: string; dailyBudgetCents: number; variants: CampaignVariantLike[] } | null> {
  const row = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!row) return null;
  const d = row.data as any;
  return { workspaceId: row.workspaceId ?? undefined, dailyBudgetCents: Number(d?.dailyBudgetCents ?? 0), variants: Array.isArray(d?.variants) ? d.variants : [] };
}

function deriveAdSetsFromCampaign(campaignId: string, campaign: { workspaceId?: string; dailyBudgetCents: number; variants: CampaignVariantLike[] }): AdSet[] {
  const now = new Date().toISOString();
  const seen = new Map<string, AdSet>();
  for (const v of campaign.variants) {
    const audience = v.audienceName?.trim() || "General Audience";
    const id = draftAdSetId(campaignId, v.network, audience);
    if (seen.has(id)) continue;
    const groupSize = campaign.variants.filter((x) => x.network === v.network && (x.audienceName?.trim() || "General Audience") === audience).length;
    seen.set(id, {
      id,
      campaignId,
      workspaceId: campaign.workspaceId,
      name: audience,
      status: v.status === "active" ? "active" : v.status === "paused" ? "paused" : "draft",
      // Draft ad sets share the campaign's daily budget split across the distinct ad sets they'll become.
      dailyBudgetCents: groupSize > 0 && campaign.dailyBudgetCents > 0 ? Math.round(campaign.dailyBudgetCents / Math.max(1, new Set(campaign.variants.map((x) => draftAdSetId(campaignId, x.network, x.audienceName?.trim() || "General Audience"))).size)) : campaign.dailyBudgetCents,
      targeting: {},
      placements: [],
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      createdAt: now,
      updatedAt: now,
    });
  }
  return [...seen.values()];
}

function deriveAdsFromCampaign(campaignId: string, adSetId: string, campaign: { variants: CampaignVariantLike[] }): Ad[] {
  const now = new Date().toISOString();
  return campaign.variants
    .filter((v) => draftAdSetId(campaignId, v.network, v.audienceName?.trim() || "General Audience") === adSetId)
    .map((v) => ({
      id: `draft-ad-${campaignId}-${v.id}`,
      adSetId,
      name: v.creative?.headline?.trim() || "Untitled ad",
      status: (v.status === "active" ? "active" : v.status === "paused" ? "paused" : "draft") as Ad["status"],
      creative: {
        headline: v.creative?.headline ?? "",
        body: v.creative?.body ?? "",
        callToAction: v.creative?.callToAction ?? "Learn More",
        ...(v.creative?.imageUrl ? { imageUrl: v.creative.imageUrl } : {}),
      },
      format: (v.creative?.videoUrl ? "video" : "single_image") as Ad["format"],
      createdAt: now,
      updatedAt: now,
    }));
}

export async function listAdSets(campaignId: string): Promise<AdSet[]> {
  const rows = await prisma.adSet.findMany({ where: { campaignId }, orderBy: { createdAt: "desc" } });
  if (rows.length > 0) return rows.map((r) => r.data as unknown as AdSet);
  // No persisted ad sets (a draft campaign, not yet launched) — derive the hierarchy it WILL
  // publish from its variants so the Ads Manager isn't empty. Best-effort: no campaign → [].
  const campaign = await loadCampaignForDerivation(campaignId);
  return campaign ? deriveAdSetsFromCampaign(campaignId, campaign) : [];
}

export async function createAdSet(campaignId: string, input: Omit<AdSet, "id" | "campaignId" | "createdAt" | "updatedAt">): Promise<AdSet> {
  const a: AdSet = { id: randomUUID(), campaignId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...input };
  await saveAdSet(a);
  return a;
}

export async function listAds(adSetId: string): Promise<Ad[]> {
  const rows = await prisma.ad.findMany({ where: { adSetId }, orderBy: { createdAt: "desc" } });
  if (rows.length > 0) return rows.map((r) => r.data as unknown as Ad);
  // Derived draft ad-set id shape is `draft-<campaignId>-<network>-<hash>` — recover the campaign
  // id (a UUID has 5 dash-separated parts) and derive this ad set's ads from the campaign variants.
  if (adSetId.startsWith("draft-")) {
    const rest = adSetId.slice("draft-".length);
    const parts = rest.split("-");
    const campaignId = parts.slice(0, 5).join("-"); // UUID = 8-4-4-4-12
    const campaign = await loadCampaignForDerivation(campaignId);
    if (campaign) return deriveAdsFromCampaign(campaignId, adSetId, campaign);
  }
  return [];
}

export async function createAd(adSetId: string, input: Omit<Ad, "id" | "adSetId" | "createdAt" | "updatedAt">): Promise<Ad> {
  const a: Ad = { id: randomUUID(), adSetId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...input };
  await saveAd(a);
  return a;
}

export async function updateAd(id: string, patch: Partial<Pick<Ad, "name" | "status" | "creative" | "format">>): Promise<Ad> {
  const row = await prisma.ad.findUnique({ where: { id } });
  if (!row) throw new Error("Ad not found");
  const a: Ad = { ...(row.data as unknown as Ad), ...patch, updatedAt: new Date().toISOString() };
  await saveAd(a);
  return a;
}

/**
 * Minimal shape of a launched campaign variant this sync needs — mirrors the CampaignVariant fields
 * populated by launchMetaHierarchy/launchGoogleHierarchy, kept local so draftsService doesn't depend
 * on the orchestrator's types.
 */
interface LaunchedVariantLike {
  id: string;
  network: string;
  status: string;
  externalId?: string;
  adSetExternalId?: string;
  audienceName?: string;
  creative: { headline: string; body: string; callToAction: string; imageUrl?: string; videoUrl?: string };
}

/**
 * Mirror a just-launched campaign's platform hierarchy into the AdSet/Ad tables the Ads Manager
 * reads. The launch flow writes real Meta/Google ad-set + ad ids onto the campaign's `variants`
 * JSON, but the Ads Manager lists prisma.adSet/prisma.ad rows — so a published campaign showed an
 * empty "Total Ads 0 / Ad Sets 0" hierarchy. This bridges the two: one AdSet row per distinct
 * `adSetExternalId`, one Ad row per launched variant under it.
 *
 * Idempotent: row ids are derived deterministically from the campaign + external ids, so re-running
 * a launch upserts in place instead of duplicating. Skips variants that never launched (no
 * externalId/adSetExternalId — e.g. failed or skipped networks), so nothing invented appears.
 */
export async function syncLaunchedHierarchy(
  campaignId: string,
  workspaceId: string | undefined,
  variants: LaunchedVariantLike[],
): Promise<{ adSets: number; ads: number }> {
  const now = new Date().toISOString();
  const launched = variants.filter((v) => v.externalId && v.adSetExternalId);
  const seenAdSets = new Set<string>();
  let adSetCount = 0;
  let adCount = 0;

  for (const v of launched) {
    const adSetRowId = `launched-${campaignId}-${v.adSetExternalId}`;
    const status: "active" | "paused" | "draft" = v.status === "active" ? "active" : v.status === "paused" ? "paused" : "draft";

    if (!seenAdSets.has(adSetRowId)) {
      seenAdSets.add(adSetRowId);
      await saveAdSet({
        id: adSetRowId,
        campaignId,
        workspaceId,
        name: v.audienceName ? v.audienceName.slice(0, 80) : `Ad set ${v.adSetExternalId}`,
        status,
        dailyBudgetCents: 0, // budget lives at campaign/variant level; ad-set figure is set by the platform
        targeting: {},
        placements: [],
        bidStrategy: "LOWEST_COST_WITHOUT_CAP",
        createdAt: now,
        updatedAt: now,
      });
      adSetCount++;
    }

    await saveAd({
      id: `launched-${campaignId}-${v.externalId}`,
      adSetId: adSetRowId,
      workspaceId,
      name: `${v.network} · ${(v.creative.headline || v.id).slice(0, 60)}`,
      status,
      creative: {
        headline: v.creative.headline,
        body: v.creative.body,
        callToAction: v.creative.callToAction,
        imageUrl: v.creative.imageUrl,
      },
      format: v.creative.videoUrl ? "video" : "single_image",
      externalId: v.externalId,
      createdAt: now,
      updatedAt: now,
    });
    adCount++;
  }

  return { adSets: adSetCount, ads: adCount };
}
