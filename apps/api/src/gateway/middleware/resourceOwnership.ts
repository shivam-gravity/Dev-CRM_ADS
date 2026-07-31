import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "./auth.js";
import { getMembership, listWorkspacesForUser } from "../../modules/workspace/workspaceService.js";
import { prisma } from "../../db/prisma.js";
import { campaignSeqFromSlug } from "../../modules/orchestrator/campaignNaming.js";

/**
 * Ownership checks for "bare-id" sub-resources — routes like PATCH /ads/:id or
 * DELETE /drafts/:id where the URL carries only the resource's own id and no
 * workspace/business context to run requireWorkspaceMember/requireBusinessAccess
 * against. Each middleware resolves the resource to its owning workspace (directly,
 * or by walking up e.g. Ad -> AdSet -> Campaign -> Business) and then checks
 * req.userId's membership, mirroring the resolve-then-check pattern the
 * /campaigns/generate/:id and /research/:id handlers already use inline.
 *
 * Fail-closed policy (same as requireBusinessAccess): a resource whose ownership
 * chain ends in a null workspaceId (created before workspace scoping, or a data bug)
 * is 403 for everyone rather than open to everyone.
 */

/** How a resource's owning workspace was resolved: missing row, resolved id, or null chain. */
type Resolution = { found: false } | { found: true; workspaceId: string | null };

function requireOwned(
  resourceLabel: string,
  resolve: (id: string) => Promise<Resolution>,
  key = "id",
  // Some creates name their parent in the BODY rather than the path (POST /campaigns carries
  // strategyId). Those still need the same check — deriving ownership from the named parent is what
  // stops a caller from planting a row in someone else's workspace by supplying a workspaceId.
  source: "params" | "body" = "params"
) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const id = source === "body" ? (req.body ?? {})[key] : req.params[key];
    if (!id || typeof id !== "string") return res.status(400).json({ error: `Missing ${key}` });
    if (!req.userId) return res.status(401).json({ error: "Not authenticated" });

    const resolution = await resolve(id);
    if (!resolution.found) return res.status(404).json({ error: `${resourceLabel} not found` });
    if (!resolution.workspaceId) {
      return res.status(403).json({ error: `This ${resourceLabel.toLowerCase()} is not assigned to a workspace` });
    }

    const membership = await getMembership(resolution.workspaceId, req.userId);
    if (!membership) return res.status(403).json({ error: `You do not have access to this ${resourceLabel.toLowerCase()}` });
    next();
  };
}

/** For models that carry their own indexed workspaceId column. */
function byOwnWorkspaceColumn(
  model: { findUnique(args: { where: { id: string }; select: { workspaceId: true } }): Promise<{ workspaceId: string | null } | null> }
): (id: string) => Promise<Resolution> {
  return async (id) => {
    const row = await model.findUnique({ where: { id }, select: { workspaceId: true } });
    return row ? { found: true, workspaceId: row.workspaceId } : { found: false };
  };
}

async function workspaceOfBusiness(businessId: string | null | undefined): Promise<string | null> {
  if (!businessId) return null;
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { workspaceId: true } });
  return business?.workspaceId ?? null;
}

/** Campaign.workspaceId is only set at launch — fall back to its business's workspace for drafts. */
async function workspaceOfCampaign(campaignId: string): Promise<Resolution> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { workspaceId: true, businessId: true } });
  if (!campaign) return { found: false };
  return { found: true, workspaceId: campaign.workspaceId ?? (await workspaceOfBusiness(campaign.businessId)) };
}

// A pre-launch draft campaign has no prisma.adSet rows; the Ads Manager lists ad sets DERIVED from
// the campaign's variants under a synthetic id `draft-<campaignId>-<network>-<hash>` (see
// draftsService.listAdSets). Such an id owns via its embedded campaign, so ownership still resolves
// to the campaign's workspace — parse the campaignId (a UUID = the first 5 dash-separated segments).
function campaignIdFromDraftAdSetId(adSetId: string): string | null {
  if (!adSetId.startsWith("draft-")) return null;
  const parts = adSetId.slice("draft-".length).split("-");
  return parts.length >= 5 ? parts.slice(0, 5).join("-") : null;
}

/** AdSet.workspaceId is not reliably populated (see draftsService.createAdSet) — walk up via its campaign. */
async function workspaceOfAdSet(adSetId: string): Promise<Resolution> {
  const draftCampaignId = campaignIdFromDraftAdSetId(adSetId);
  if (draftCampaignId) return workspaceOfCampaign(draftCampaignId);
  const adSet = await prisma.adSet.findUnique({ where: { id: adSetId }, select: { workspaceId: true, campaignId: true } });
  if (!adSet) return { found: false };
  if (adSet.workspaceId) return { found: true, workspaceId: adSet.workspaceId };
  const viaCampaign = await workspaceOfCampaign(adSet.campaignId);
  return viaCampaign.found ? viaCampaign : { found: true, workspaceId: null };
}

export const requireNotificationAccess = requireOwned("Notification", byOwnWorkspaceColumn(prisma.notification));
export const requireAssetAccess = requireOwned("Asset", byOwnWorkspaceColumn(prisma.asset));
export const requireInsightAccess = requireOwned("Insight", byOwnWorkspaceColumn(prisma.insight));
export const requireSavedAudienceAccess = requireOwned("Audience", byOwnWorkspaceColumn(prisma.savedAudience));
export const requireDraftAccess = requireOwned("Draft", byOwnWorkspaceColumn(prisma.draft));
export const requireDeveloperWebhookAccess = requireOwned("Webhook", byOwnWorkspaceColumn(prisma.developerWebhook));
export const requireAutomationRuleAccess = requireOwned("Automation rule", byOwnWorkspaceColumn(prisma.automationRule));
export const requireGenerationJobAccess = requireOwned("Generation job", byOwnWorkspaceColumn(prisma.generationJob));

const resolveStrategyWorkspace = async (id: string): Promise<Resolution> => {
  const strategy = await prisma.strategy.findUnique({ where: { id }, select: { businessId: true } });
  if (!strategy) return { found: false };
  return { found: true, workspaceId: await workspaceOfBusiness(strategy.businessId) };
};

export const requireStrategyAccess = requireOwned("Strategy", resolveStrategyWorkspace);

/**
 * Same check for POST /campaigns, where the strategy is named in the body.
 *
 * The campaign inherits its business and workspace from this strategy, so proving the caller may
 * use the strategy is exactly the right authorization — and it is what the route previously lacked
 * entirely while trusting a client-supplied workspaceId.
 */
export const requireStrategyAccessFromBody = requireOwned("Strategy", resolveStrategyWorkspace, "strategyId", "body");

export const requireCreativeAccess = requireOwned("Creative", async (id) => {
  const creative = await prisma.creative.findUnique({ where: { id }, select: { workspaceId: true, businessId: true } });
  if (!creative) return { found: false };
  return { found: true, workspaceId: creative.workspaceId ?? (await workspaceOfBusiness(creative.businessId)) };
});

/** Canonical UUID v4-ish shape — enough to tell "this is already an id" from "this is a slug". */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accept a human-readable campaign slug ("c-0007-polluxa-traffic") anywhere a campaign id is
 * expected, rewriting :id to the real UUID before anything downstream runs.
 *
 * Doing the translation here — rather than in each handler — means every existing campaign route
 * gained clean URLs without being touched, and every ownership check still operates on a real id.
 *
 * Scoped to the caller's own workspaces, which is not optional: the sequence behind a slug is
 * per-workspace (see allocateCampaignSeq), so "c-0007" exists in as many tenants as have seven
 * campaigns. Resolving globally would hand a user another tenant's campaign id — requireCampaignAccess
 * would then correctly 403, but the user would be denied their OWN campaign, which reads as a
 * permissions bug. Matching only within their workspaces makes the right row the only candidate.
 *
 * Leaves the param untouched when it is already a UUID, when it carries no parseable ref, or when
 * nothing matches — the normal 404 path then applies, unchanged.
 */
export async function resolveCampaignSlugParam(req: AuthedRequest, res: Response, next: NextFunction) {
  const raw = req.params.id;
  if (!raw || UUID_SHAPE.test(raw) || !req.userId) return next();
  const seq = campaignSeqFromSlug(raw);
  if (seq === null) return next();
  try {
    const workspaces = await listWorkspacesForUser(req.userId);
    if (!workspaces.length) return next();
    const match = await prisma.campaign.findFirst({
      where: {
        workspaceId: { in: workspaces.map((w) => w.id) },
        data: { path: ["seq"], equals: seq },
      },
      select: { id: true },
    });
    if (match) req.params.id = match.id;
  } catch {
    // Slug resolution is a convenience over the canonical id. If it fails, fall through and let the
    // route 404 rather than turning a bad lookup into a 500 on an otherwise valid request.
  }
  next();
}

// Array form so every existing `router.x("/campaigns/:id/…", requireCampaignAccess, …)` registration
// picks up slug support without being edited.
export const requireCampaignAccess = [resolveCampaignSlugParam, requireOwned("Campaign", workspaceOfCampaign)];
export const requireAdSetAccess = requireOwned("Ad set", workspaceOfAdSet);

export const requireAdAccess = requireOwned("Ad", async (id) => {
  const ad = await prisma.ad.findUnique({ where: { id }, select: { workspaceId: true, adSetId: true } });
  if (!ad) return { found: false };
  if (ad.workspaceId) return { found: true, workspaceId: ad.workspaceId };
  const viaAdSet = await workspaceOfAdSet(ad.adSetId);
  return viaAdSet.found ? viaAdSet : { found: true, workspaceId: null };
});

export const requireCompetitorAccess = requireOwned("Competitor", byOwnWorkspaceColumn(prisma.competitor));
