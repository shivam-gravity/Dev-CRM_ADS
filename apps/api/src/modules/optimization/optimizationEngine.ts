import { normalizePerformance, getRawMetrics, conversionsInTrailingWindow } from "../pipeline/performancePipeline.js";
import { getCampaign, pauseVariant, reallocateBudget } from "../orchestrator/campaignOrchestrator.js";
import { tuneAudiences } from "./audienceTuning.js";
import { computeFatigueScore } from "./creativeFatigueDetector.js";
import { thompsonPick, type BanditArm } from "./banditSampling.js";
import { createGenerationJob, hasRecentFatigueRefresh } from "../generation/generationJobService.js";
import { creativeGenerationQueue } from "../../infra/queue.js";
import type { NormalizedPerformance, OptimizationDecision } from "../../types/index.js";

// Minimum conversions before a variant's CPA is trusted enough to PAUSE it. A pause on 1–2
// conversions is deciding on noise; real significance needs a double-digit sample.
const MIN_CONVERSIONS_TO_PAUSE = 10;
const MAX_CPA_MULTIPLIER = 2.5; // pause a variant once its CPA exceeds this multiple of the cohort's best CPA
// Meta's learning phase needs ~50 conversions per ad set per week to exit and deliver stably, and
// moving an ad set's budget RESETS that phase. So a variant still under this trailing-7d threshold
// holds its budget — reallocating it would keep it perpetually re-learning and under-delivering,
// the single biggest killer of small-budget campaigns. Env-tunable for accounts with other rules.
const LEARNING_PHASE_CONVERSIONS = Math.max(1, Number(process.env.LEARNING_PHASE_CONVERSIONS) || 50);
// Don't re-trigger a fatigue refresh for the same variant on every 15-minute tick while it
// stays fatigued — give the creative-generation pipeline (and a human reviewing the result)
// a full day before considering that variant for another automatic refresh.
const FATIGUE_REFRESH_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Builds a generation prompt from a live variant's own creative — reused when a fatigue
 * refresh triggers, since there's no guarantee a landingPageUrl is set (creativeGenerationService's
 * resolveContext needs either a productUrl or a prompt).
 */
function fatigueRefreshPrompt(creative: { headline: string; body: string }): string {
  return `Generate a fresh ad variation for a product/business currently advertised with the headline "${creative.headline}" and body copy "${creative.body}". Keep the same underlying product/offer, but produce a genuinely different creative angle and image — the current one has been running long enough that the audience is tuning it out.`;
}

/**
 * Thompson-sampling multi-armed bandit over campaign variants, with a learning-phase gate.
 * Models each variant's conversion rate as a Beta posterior and samples to pick the arm to
 * exploit (uncertainty drives exploration — no fixed epsilon), holds any variant still in its ad-
 * network learning phase so a reallocation doesn't reset delivery, and pauses a clear loser only on
 * a trustworthy conversion sample. Feeds decisions back to the orchestrator, closing the loop from
 * performance data -> budget/pause actions.
 */
export async function runOptimizationPass(campaignId: string): Promise<OptimizationDecision[]> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  const stats = await normalizePerformance(campaignId);
  const decisions: OptimizationDecision[] = [];
  const decidedAt = new Date().toISOString();

  if (stats.length === 0) return decisions;

  const activeVariants = campaign.variants.filter((v) => v.status === "active");
  const perVariantBudget = Math.floor(campaign.dailyBudgetCents / Math.max(activeVariants.length, 1));

  // Fatigue and budget/pause decisions are orthogonal — a variant can be converting fine
  // (no CPA/budget action warranted) while still showing a real fatigue signal, so this
  // check runs independently of the pause/budget branches below rather than being folded
  // into either.
  const dailyMetrics = await getRawMetrics(campaignId);

  // Learning-phase gate: recent (trailing-7d) conversions per variant. A variant under the
  // threshold is still stabilizing on the ad network and must not have its budget moved.
  const recentConversions = conversionsInTrailingWindow(dailyMetrics);
  const inLearningPhase = (variantId: string): boolean =>
    (recentConversions.get(variantId) ?? 0) < LEARNING_PHASE_CONVERSIONS;

  // Winner selection by Thompson sampling: model each variant's conversion rate as a Beta
  // posterior (successes = conversions, failures = non-converting clicks) and let the draw pick
  // the arm to exploit. Uncertainty drives exploration automatically — a fresh variant with a wide
  // posterior can still win a draw and earn budget — replacing the old fixed-epsilon coin-flip. A
  // variant still in its learning phase is excluded from being the *budget-boost* winner (boosting
  // it would move its budget and reset learning), but stays eligible once it graduates.
  const arms: BanditArm[] = stats
    .filter((s) => !inLearningPhase(s.variantId))
    .map((s) => ({ id: s.variantId, successes: s.conversions, failures: Math.max(s.clicks - s.conversions, 0) }));
  const winnerId = thompsonPick(arms);
  // CPA-pause cohort still uses only variants with a trustworthy conversion sample.
  const pausable = stats.filter((s) => s.conversions >= MIN_CONVERSIONS_TO_PAUSE);
  const bestCpa = pausable.filter((s) => s.cpaCents !== null).sort((a, b) => (a.cpaCents ?? Infinity) - (b.cpaCents ?? Infinity))[0]?.cpaCents;

  for (const variant of activeVariants) {
    if (campaign.workspaceId) {
      const fatigue = computeFatigueScore(variant.id, dailyMetrics);
      if (fatigue.isFatigued) {
        const cooldownSince = new Date(Date.now() - FATIGUE_REFRESH_COOLDOWN_MS).toISOString();
        const alreadyTriggered = await hasRecentFatigueRefresh(campaign.businessId, variant.id, cooldownSince);
        if (!alreadyTriggered) {
          const job = await createGenerationJob(campaign.workspaceId, {
            businessId: campaign.businessId,
            prompt: variant.landingPageUrl ? undefined : fatigueRefreshPrompt(variant.creative),
            productUrl: variant.landingPageUrl,
            wantVideo: false,
            campaignId,
            variantId: variant.id,
            reason: "fatigue-refresh",
          });
          await creativeGenerationQueue.add("generate", { jobId: job.id });
          decisions.push({
            campaignId,
            chosenVariantId: variant.id,
            action: "regenerate_creative",
            reason: `Fatigue detected (${fatigue.reason}) — queued a fresh creative for review`,
            decidedAt,
          });
        }
      }
    }

    const stat = stats.find((s) => s.variantId === variant.id);
    if (!stat) {
      decisions.push({ campaignId, chosenVariantId: variant.id, action: "hold", reason: "No performance data yet", decidedAt });
      continue;
    }

    // Pause a clearly-losing variant only on a trustworthy conversion sample (>= MIN_CONVERSIONS_TO_PAUSE)
    // — pausing on 1–2 conversions is acting on noise. bestCpa is already computed from that same cohort.
    if (
      typeof bestCpa === "number" &&
      stat.cpaCents !== null &&
      stat.conversions >= MIN_CONVERSIONS_TO_PAUSE &&
      stat.cpaCents > bestCpa * MAX_CPA_MULTIPLIER
    ) {
      await pauseVariant(campaignId, variant.id);
      decisions.push({
        campaignId,
        chosenVariantId: variant.id,
        action: "pause",
        reason: `CPA ${(stat.cpaCents / 100).toFixed(2)} exceeds ${MAX_CPA_MULTIPLIER}x the cohort best (${(bestCpa / 100).toFixed(2)})`,
        decidedAt,
      });
      continue;
    }

    // Learning phase: never move this variant's budget — a reallocation resets the ad network's
    // learning and keeps it under-delivering. Hold until it graduates (trailing-7d conversions
    // clear the threshold).
    if (inLearningPhase(variant.id)) {
      decisions.push({
        campaignId,
        chosenVariantId: variant.id,
        action: "hold",
        reason: `In learning phase (${recentConversions.get(variant.id) ?? 0}/${LEARNING_PHASE_CONVERSIONS} conv. this week) — holding budget to avoid resetting delivery`,
        decidedAt,
      });
      continue;
    }

    // Thompson-sampled winner (chosen once, above) gets a budget boost; other graduated variants
    // are trimmed to fund it. A variant with no graduated peers (winner is the only arm) just holds.
    const isWinner = winnerId != null && variant.id === winnerId;

    if (isWinner) {
      const boosted = Math.round(perVariantBudget * 1.3);
      await reallocateBudget(campaignId, variant.id, boosted);
      decisions.push({
        campaignId,
        chosenVariantId: variant.id,
        action: "increase_budget",
        reason: `Thompson-sampled winner (conv. rate ${(stat.conversionRate * 100).toFixed(1)}%, CTR ${(stat.ctr * 100).toFixed(1)}%) — exploiting`,
        decidedAt,
      });
    } else if (winnerId != null) {
      const reduced = Math.round(perVariantBudget * 0.85);
      await reallocateBudget(campaignId, variant.id, reduced);
      decisions.push({
        campaignId,
        chosenVariantId: variant.id,
        action: "decrease_budget",
        reason: "Below the sampled leader — trimming spend to fund the winner",
        decidedAt,
      });
    } else {
      decisions.push({ campaignId, chosenVariantId: variant.id, action: "hold", reason: "Accumulating data before reallocating", decidedAt });
    }
  }

  // Audience-level tuning runs after the per-variant pass: the variant loop optimizes individual
  // ads, this prunes a whole audience segment that's structurally unprofitable (targeting is
  // otherwise frozen at launch). Uses the same stats snapshot so it doesn't double-count spend.
  const audienceDecisions = await tuneAudiences(campaign, stats);
  decisions.push(...audienceDecisions);

  return decisions;
}
