import { randomUUID } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { normalizePerformance } from "../../modules/pipeline/performancePipeline.js";
import { getCampaign } from "../../modules/orchestrator/campaignOrchestrator.js";
import { getBusiness } from "../../modules/business/businessService.js";
import { getStrategy } from "../../modules/strategy/strategyEngine.js";
import { logger } from "../../modules/logger/logger.js";
import type { AdNetwork, NormalizedPerformance } from "../../types/index.js";
import type { DecisionContext } from "./types.js";
import type { CampaignGenerationJobRecord } from "../../modules/orchestrator/campaignGenerationService.js";

/**
 * Populates the 3 "Campaign Intelligence & Learning System" tables added by the
 * 2026-07-10 migration (schema.prisma's CampaignPerformanceSnapshot/RecommendationFeedback/
 * SuccessPattern) — modeled back then but never actually written to by any code until now.
 * Every write here is derived from real ad-network/decision-engine data already computed
 * elsewhere; nothing here fabricates a number to fill a column.
 */

interface NetworkBreakdownEntry {
  network: AdNetwork;
  impressions: number;
  clicks: number;
  conversions: number;
  spendCents: number;
  ctr: number;
  roas: number | null;
}

function aggregateByNetwork(stats: NormalizedPerformance[]): NetworkBreakdownEntry[] {
  const byNetwork = new Map<AdNetwork, NormalizedPerformance[]>();
  for (const s of stats) byNetwork.set(s.network, [...(byNetwork.get(s.network) ?? []), s]);

  return [...byNetwork.entries()].map(([network, group]) => {
    const impressions = group.reduce((sum, g) => sum + g.impressions, 0);
    const clicks = group.reduce((sum, g) => sum + g.clicks, 0);
    const conversions = group.reduce((sum, g) => sum + g.conversions, 0);
    const spendCents = group.reduce((sum, g) => sum + g.spendCents, 0);
    const revenueCents = group.reduce((sum, g) => sum + g.revenueCents, 0);
    return {
      network,
      impressions,
      clicks,
      conversions,
      spendCents,
      ctr: impressions > 0 ? clicks / impressions : 0,
      roas: spendCents > 0 && conversions > 0 ? revenueCents / spendCents : null,
    };
  });
}

/**
 * Writes one point-in-time CampaignPerformanceSnapshot from whatever real metrics exist
 * right now — ungated by statistical significance (unlike recordCampaignOutcome's 5-
 * conversion floor in campaign-learning-engine.ts), since a snapshot is just "what the
 * numbers say today," not a claim about a reliable outcome. No-op when there's no metric
 * data at all yet. Best-effort: never throws, since it runs alongside the metrics-ingestion
 * tick and shouldn't be able to break it.
 */
export async function recordPerformanceSnapshot(campaignId: string): Promise<void> {
  try {
    const stats = await normalizePerformance(campaignId);
    if (stats.length === 0) return;

    const campaign = await getCampaign(campaignId);
    if (!campaign) return;
    // Snapshots are cross-campaign LEARNING data, keyed by workspace. Attributing an unattributable
    // campaign to "demo" (as this did) would fold one tenant's performance into another's benchmarks
    // and skew every recommendation built from them. Skip it instead — the column is required, so
    // there is no honest value to write here.
    if (!campaign.workspaceId) {
      logger.warn(`recordPerformanceSnapshot: campaign ${campaignId} has no workspace — skipping rather than mis-attributing its performance.`);
      return;
    }

    const business = await getBusiness(campaign.businessId);
    const networkBreakdown = aggregateByNetwork(stats);

    const impressions = stats.reduce((sum, s) => sum + s.impressions, 0);
    const reach = stats.reduce((sum, s) => sum + s.reach, 0);
    const clicks = stats.reduce((sum, s) => sum + s.clicks, 0);
    const conversions = stats.reduce((sum, s) => sum + s.conversions, 0);
    const spendCents = stats.reduce((sum, s) => sum + s.spendCents, 0);
    const revenueCents = stats.reduce((sum, s) => sum + s.revenueCents, 0);
    const distinctNetworks = [...new Set(stats.map((s) => s.network))];

    await prisma.campaignPerformanceSnapshot.create({
      data: {
        id: randomUUID(),
        campaignId,
        workspaceId: campaign.workspaceId,
        businessId: campaign.businessId,
        industry: business?.industry,
        platform: distinctNetworks.length === 1 ? distinctNetworks[0] : undefined,
        impressions,
        clicks,
        conversions,
        spendCents,
        revenueCents,
        ctr: impressions > 0 ? clicks / impressions : 0,
        cpcCents: clicks > 0 ? spendCents / clicks : undefined,
        cpaCents: conversions > 0 ? spendCents / conversions : undefined,
        roas: spendCents > 0 && conversions > 0 ? revenueCents / spendCents : undefined,
        // Sum of per-variant reach double-counts any user reached by more than one variant —
        // a real proxy (same convention creativeFatigueDetector.ts uses per-variant), not a
        // true deduplicated union reach, which no adapter here exposes at the campaign level.
        frequency: reach > 0 ? impressions / reach : undefined,
        metadata: { networkBreakdown, strategyId: campaign.strategyId } as any,
      },
    });
  } catch (err) {
    logger.warn(`recordPerformanceSnapshot failed for campaign ${campaignId}`, err);
  }
}

function recommendationKey(category: string, title: string): string {
  return `${category}::${title.toLowerCase().slice(0, 80)}`;
}

// Matches strategy-engine.ts's own `recommendations.slice(0, 5)` — the actual set of
// top-ranked recommendations that fed the strategy this campaign was built from. Anything
// ranked below that genuinely wasn't used, which is what "ignored" here means — nothing
// fancier than "existed in this decision context but didn't make the cut."
const TOP_RECOMMENDATIONS_USED = 5;

/**
 * Called once, right after a campaign finishes building from a DecisionContext — records
 * one RecommendationFeedback row per recommendation the Decision Engine produced, "accepted"
 * for the top 5 that actually informed the built strategy, "ignored" for the rest. Best-
 * effort, matching this pipeline's existing posture toward Decision Engine output (never
 * blocks/fails campaign generation).
 */
export async function recordRecommendationDecisions(params: {
  workspaceId: string;
  businessId: string;
  campaignId: string;
  decisionContext: DecisionContext;
}): Promise<void> {
  const { workspaceId, businessId, campaignId, decisionContext } = params;
  try {
    const acceptedKeys = new Set(
      decisionContext.recommendations.slice(0, TOP_RECOMMENDATIONS_USED).map((r) => recommendationKey(r.category, r.title))
    );

    for (const recommendation of decisionContext.recommendations) {
      const status = acceptedKeys.has(recommendationKey(recommendation.category, recommendation.title)) ? "accepted" : "ignored";
      const existing = await prisma.recommendationFeedback.findFirst({
        where: { workspaceId, campaignId, category: recommendation.category, title: recommendation.title },
      });
      if (existing) {
        await prisma.recommendationFeedback.update({ where: { id: existing.id }, data: { status, recommendationId: recommendation.id } });
      } else {
        await prisma.recommendationFeedback.create({
          data: {
            id: randomUUID(),
            workspaceId,
            businessId,
            recommendationId: recommendation.id,
            category: recommendation.category,
            title: recommendation.title,
            status,
            campaignId,
          },
        });
      }
    }
  } catch (err) {
    logger.warn(`recordRecommendationDecisions failed for campaign ${campaignId}`, err);
  }
}

// A real, if generous, "this campaign is working" bar — well below ROAS_CEILING (4) in
// campaign-learning-engine.ts (that's the score-maxing ceiling, not a pass/fail line), and
// consistent with the plain "2x return" a marketer would call profitable.
const WINNING_ROAS_THRESHOLD = 2;
const MIN_CONVERSIONS_FOR_PATTERN = 3;

/**
 * Called once a campaign's outcome has cleared campaign-learning-engine.ts's statistical
 * floor (5+ conversions) — advances any "accepted" RecommendationFeedback rows to
 * "implemented" with a real effectivenessScore, and — for whichever networks this campaign
 * is actually winning on — upserts a SuccessPattern so the same audience+creative+offer+
 * platform combination gets more confident the more times it wins, never recomputed from
 * scratch. No-ops quietly when there's no decisionContext/strategy to attribute a pattern to.
 */
export async function recordRecommendationOutcomeAndPattern(params: {
  campaignId: string;
  job: CampaignGenerationJobRecord;
  outcome: { outcomeScore: number; ctr: number; conversionRate: number; roas: number | null; totalConversions: number };
}): Promise<void> {
  const { campaignId, job, outcome } = params;
  try {
    const outcomeSummary = `${outcome.outcomeScore}/100 (CTR ${(outcome.ctr * 100).toFixed(2)}%, conversion rate ${(outcome.conversionRate * 100).toFixed(2)}%${
      outcome.roas !== null ? `, ROAS ${outcome.roas}x` : ""
    })`;

    await prisma.recommendationFeedback.updateMany({
      where: { campaignId, status: "accepted" },
      data: { status: "implemented", effectivenessScore: outcome.outcomeScore / 100, outcomeSummary },
    });

    if (!job.decisionContext) return;

    const campaign = await getCampaign(campaignId);
    if (!campaign) return;
    const strategy = campaign.strategyId ? await getStrategy(campaign.strategyId) : null;

    const audience = job.decisionContext.recommendedAudiencePriority || strategy?.audiences[0] || "unspecified";
    const creative = strategy?.creatives[0]?.headline || "unspecified";
    const offer = job.decisionContext.recommendedOffer || "unspecified";

    const snapshot = await prisma.campaignPerformanceSnapshot.findFirst({
      where: { campaignId },
      orderBy: { capturedAt: "desc" },
    });
    const networkBreakdown = (snapshot?.metadata as { networkBreakdown?: NetworkBreakdownEntry[] } | null)?.networkBreakdown ?? [];

    for (const entry of networkBreakdown) {
      if (entry.roas === null || entry.roas < WINNING_ROAS_THRESHOLD || entry.conversions < MIN_CONVERSIONS_FOR_PATTERN) continue;

      const existing = await prisma.successPattern.findFirst({
        where: { workspaceId: job.workspaceId, audience, creative, offer, platform: entry.network },
      });
      if (existing) {
        const occurrences = existing.occurrences + 1;
        await prisma.successPattern.update({
          where: { id: existing.id },
          data: {
            occurrences,
            avgRoas: ((existing.avgRoas ?? 0) * existing.occurrences + entry.roas) / occurrences,
            avgCtr: ((existing.avgCtr ?? 0) * existing.occurrences + entry.ctr) / occurrences,
            confidence: Math.min(1, occurrences / 10),
          },
        });
      } else {
        await prisma.successPattern.create({
          data: {
            id: randomUUID(),
            workspaceId: job.workspaceId,
            audience,
            creative,
            offer,
            platform: entry.network,
            occurrences: 1,
            avgRoas: entry.roas,
            avgCtr: entry.ctr,
            confidence: 0.1,
          },
        });
      }
    }
  } catch (err) {
    logger.warn(`recordRecommendationOutcomeAndPattern failed for campaign ${campaignId}`, err);
  }
}
