import type { AdNetwork, Campaign } from "../../types/index.js";
import { getCampaignGenerationJob, markCampaignGenerationCompleted } from "./campaignGenerationService.js";
import { buildCampaignFromStrategy, getCampaign, saveCampaign } from "./campaignOrchestrator.js";
import { getStrategy } from "../strategy/strategyEngine.js";
import { getBusiness } from "../business/businessService.js";
import { getMetaCredentials, getOrCreateIntegrations } from "../integrations/integrationService.js";
import { buildCampaignFeasibilityWarnings } from "./budgetStructure.js";
import { conversionEventMismatchError, isValidObjective, getObjectiveLabel, normalizeConversionEvent } from "../adapters/metaObjectives.js";
import { vectorAdGenerationQueue, VECTOR_AD_GENERATION_QUEUE } from "../../infra/queue.js";
import { isVectorImageGenerationEnabled } from "../generation/vectorAdImageService.js";
import { withLock, LockAlreadyHeldError } from "../../infra/distributedLock.js";
import { logger } from "../logger/logger.js";

/**
 * Finish a generation job whose campaign build was DEFERRED.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────
 * The pipeline used to research a site AND write every ad in one run, then show the Promotion
 * Objective card. By the time the user chose an objective, budget, platforms and locations, the
 * ads already existed — so their answers could only edit or discard work already paid for, and
 * unticking Google still cost a full set of Google ads.
 *
 * With `deferBuild`, the run stops once the strategy exists. Everything the results page shows
 * (candidate strategies, personas, verified facts, recommendations) comes from research, so the
 * user can decide with real information in front of them. This function then writes the ads using
 * what they actually chose.
 *
 * Idempotent: a job that already has a campaign returns it untouched. The endpoint is reachable
 * from a double-clicked button and from a retried request, and building twice would mean two
 * campaigns — and later, two sets of ads — from one intent.
 */
export interface FinishBuildInput {
  /** Meta ODAX objective (OUTCOME_SALES, …). Ignored if not a valid post-ODAX code. */
  objective?: string;
  dailyBudgetCents?: number;
  /** Networks to build for. Undefined keeps the strategy's own recommendation. */
  channels?: AdNetwork[];
  /** Target countries, stamped onto campaign.locations. */
  countries?: string[];
  /** Meta conversion event (PURCHASE, LEAD, …) for the ad set's promoted object. */
  conversionEvent?: string;
}

export interface FinishBuildResult {
  campaign: Campaign;
  /** True when the campaign already existed and nothing new was built. */
  alreadyBuilt: boolean;
  /**
   * Advisory, user-safe notes about what this budget can realistically buy — how many audiences it
   * funds, which conversion event it can feed, the estimated cost per lead. Never gates the build.
   *
   * The point is that the expected outcome is on screen BEFORE the money is committed. Previously
   * the only place budget was compared against ad-set count was a logger.warn at launch, long after
   * the user could act on it.
   */
  warnings?: string[];
}

/** Mirrors the pipeline's own campaign naming so a deferred build is indistinguishable from a direct one. */
function campaignNameFor(brand: string | undefined, objective: string | undefined, timeZone: string | undefined, url: string): string {
  const label = objective && isValidObjective(objective) ? getObjectiveLabel(objective) : "Campaign";
  const day = new Date().toLocaleDateString("en-CA", timeZone ? { timeZone } : undefined);
  const name = brand?.trim() || url.replace(/^https?:\/\//i, "").replace(/\/.*$/, "") || "Campaign";
  return `${name} · ${label} · ${day}`;
}

export async function finishCampaignGenerationBuild(jobId: string, input: FinishBuildInput): Promise<FinishBuildResult> {
  // Serialize per job: two concurrent finishes would each read campaignId=null and both build.
  try {
    return await withLock(`campaign-build:${jobId}`, 5 * 60_000, () => finishInner(jobId, input));
  } catch (err) {
    if (err instanceof LockAlreadyHeldError) throw new Error("This campaign is already being built");
    throw err;
  }
}

async function finishInner(jobId: string, input: FinishBuildInput): Promise<FinishBuildResult> {
  const job = await getCampaignGenerationJob(jobId);
  if (!job) throw new Error(`Campaign generation job ${jobId} not found`);

  if (job.campaignId) {
    const existing = await getCampaign(job.campaignId);
    if (existing) return { campaign: existing, alreadyBuilt: true };
    // The pointer survived but the campaign did not (deleted by hand) — fall through and rebuild
    // rather than 500 on a dangling reference.
    logger.warn(`finishCampaignGenerationBuild: job ${jobId} points at missing campaign ${job.campaignId} — rebuilding`);
  }

  if (!job.strategyId) {
    throw new Error("This generation run has no strategy yet — wait for research to finish before generating the campaign");
  }
  const strategy = await getStrategy(job.strategyId);
  if (!strategy) throw new Error(`Strategy ${job.strategyId} not found for generation job ${jobId}`);

  const business = await getBusiness(job.businessId);
  const objective = input.objective && isValidObjective(input.objective) ? input.objective : undefined;

  // Reject a crossed objective/conversion-event pair HERE, before buildCampaignFromStrategy runs.
  // The launch guard catches it too, but only after a campaign has been generated and the user has
  // spent time reviewing creatives — and previously not even then: the pair was persisted verbatim
  // and only surfaced as four "Failed" ads plus an orphaned campaign container on Meta.
  if (objective && input.conversionEvent) {
    const mismatch = conversionEventMismatchError(objective, input.conversionEvent);
    if (mismatch) throw new Error(mismatch);
  }

  // Ad-account timezone only affects which calendar day the name carries — never fail the build
  // for it, the same posture the pipeline takes.
  const timeZone = await getOrCreateIntegrations(job.workspaceId)
    .then((list) => {
      const meta = list.find((i) => i.platform === "meta" && i.status === "connected");
      const tz = meta?.settings?.timezoneName;
      return typeof tz === "string" && tz.trim() ? tz.trim() : undefined;
    })
    .catch(() => undefined);

  const dailyBudgetCents =
    input.dailyBudgetCents && input.dailyBudgetCents > 0 ? input.dailyBudgetCents : job.dailyBudgetCents ?? 2000;

  const campaign = await buildCampaignFromStrategy(
    job.strategyId,
    campaignNameFor(business?.name, objective, timeZone, job.url),
    dailyBudgetCents,
    objective,
    input.channels,
    input.countries
  );

  // conversionEvent is not a buildCampaignFromStrategy parameter (it is a Meta ad-set concern, not
  // a variant one), so it is applied to the built campaign directly.
  if (input.conversionEvent) {
    // Normalised because the wizard's picker sends lowercase ("purchase") while the builder sends
    // uppercase — custom_event_type is an uppercase Graph enum either way.
    campaign.conversionEvent = normalizeConversionEvent(input.conversionEvent);
    campaign.updatedAt = new Date().toISOString();
    await saveCampaign(campaign);
  }

  // What will this budget actually buy? Computed from the BUILT campaign so the numbers describe
  // what was really created: audiencePool holds everything the strategy produced, while the distinct
  // audienceNames across variants are the ad sets that will publish.
  const warnings = await buildCampaignFeasibilityWarnings(campaign, job.workspaceId, async (ws) => (await getMetaCredentials(ws))?.currency);

  await markCampaignGenerationCompleted(jobId, campaign.id);

  // Creative images, matching the pipeline's behaviour. Deliberately enqueued WITHOUT a research
  // context: the worker rebuilds one from strategyId when none is supplied, which avoids reloading
  // the whole ResearchContext here just to hand back a summary the worker can already derive.
  // Best-effort — the campaign is usable without images and must not fail on a queue error.
  if (isVectorImageGenerationEnabled()) {
    const missingVisuals = campaign.variants.filter((v) => !v.creative?.imageUrl && !v.creative?.videoUrl).length;
    if (missingVisuals > 0) {
      await vectorAdGenerationQueue
        .add(VECTOR_AD_GENERATION_QUEUE, {
          workspaceId: job.workspaceId,
          businessId: job.businessId,
          campaignId: campaign.id,
          strategyId: job.strategyId,
          generationJobId: jobId,
          count: missingVisuals,
        })
        .catch((err) => logger.warn(`finishCampaignGenerationBuild: could not enqueue images for ${campaign.id} — campaign is unaffected`, err));
    }
  }

  logger.info(
    `finishCampaignGenerationBuild: built campaign ${campaign.id} for job ${jobId} ` +
      `(networks=${campaign.networks.join(",")}, variants=${campaign.variants.length}, budget=${dailyBudgetCents})`
  );
  return { campaign, alreadyBuilt: false, ...(warnings.length ? { warnings } : {}) };
}
