import { resolveDeliveryRates } from "../adapters/budgetSimulator.js";
import { minDailyBudgetCents } from "../adapters/metaAdapter.js";

/**
 * Budget-aware campaign STRUCTURING.
 *
 * Publishing a campaign successfully and publishing one that can actually produce results are two
 * different problems. C-0013 (Rs100/day, Leads, INR) was configured to optimise for a website LEAD
 * conversion, and the arithmetic that governs whether that can ever work is not Meta's ad-set
 * minimum — it is Meta's LEARNING PHASE:
 *
 *   Rs100/day = Rs700/week. Meta needs ~50 conversions per ad set per week to exit learning.
 *   50 conversions out of Rs700 implies a Rs14 cost per lead. The measured model below puts a real
 *   lead nearer Rs37. So the ad set never exits learning, Meta throttles delivery, and the cost per
 *   lead climbs further.
 *
 * There are two distinct floors, and conflating them is what produced a campaign that was valid and
 * useless at the same time:
 *
 *   - minDailyBudgetCents(currency)  — the budget below which Meta REJECTS an ad set.
 *   - viablePerAdSetBudgetCents(...) — the budget below which an ad set is accepted but never learns.
 *
 * Everything here derives from resolveDeliveryRates in budgetSimulator, whose Indian CPM is anchored
 * on a real measured INR account (Rs29.85 CPM), rather than a second set of invented constants.
 * These remain HEURISTICS — directional, pre-spend estimates, not forecasts.
 */

/** Conversions per ad set per week Meta needs to exit the learning phase. Meta's own published
 *  guidance; the single most important number in paid social and nowhere in this codebase before. */
export const LEARNING_PHASE_CONVERSIONS_PER_WEEK = 50;

/** Hard ceiling on audiences regardless of budget — beyond this, spend fragments faster than it
 *  buys signal, and a big budget is better spent deepening a few ad sets than adding more. */
export const MAX_AUDIENCE_SEGMENTS = 3;

/** Ads to keep in a single ad set on a budget that only supports one. Meta needs a few creatives to
 *  choose between, but each extra ad dilutes an already-thin exploration budget. */
export const MAX_ADS_PER_LOW_BUDGET_ADSET = 3;

/**
 * How much cheaper an on-Meta instant-form lead is than a website-conversion lead.
 *
 * An instant form removes the landing page, the page load, and the pixel round-trip — the user taps
 * and Meta prefills their details. The trade is intent: an instant-form lead has not read the
 * landing page, so it is cheaper AND colder. 4x is a deliberately conservative midpoint of the
 * commonly reported 3-10x; being wrong low here means under-promising, which is the safe direction.
 */
const INSTANT_FORM_LEAD_DISCOUNT = 4;

/** Share of link clicks that become a landing page view — the rest bounce before the page renders.
 *  Meta's own LANDING_PAGE_VIEWS optimisation exists precisely because this gap is real. */
const LANDING_PAGE_VIEW_RATE = 0.8;

export interface EconomicsInput {
  objective?: string;
  platforms?: ("meta" | "google")[];
  countries?: string[];
  currency?: string;
  /**
   * The user's own target cost per lead/acquisition, in cents. When set it REPLACES the modelled
   * cost per conversion, because an advertiser who knows what a lead costs them knows better than a
   * heuristic built from industry-midpoint CTR/CVR. It flows through every downstream decision:
   * how many audiences the budget funds, whether conversion optimisation is reachable, and the
   * projection shown before spend.
   */
  targetCpaCents?: number;
}

/** Estimated cost of one of each event type, in app-internal cents (wholeUnits * 100), in the ad
 *  account's own currency. Budget-independent by construction — cost per event does not change
 *  because you spend more, only the count does. */
export interface DeliveryEconomics {
  cpmCents: number;
  costPerClickCents: number;
  costPerLandingPageViewCents: number;
  /** Website conversion via the pixel — the most expensive way to buy a lead. */
  costPerConversionCents: number;
  /** On-Meta instant form. */
  costPerInstantFormLeadCents: number;
}

export function estimateDeliveryEconomics(input: EconomicsInput): DeliveryEconomics {
  const { cpmCents, ctr, cvr } = resolveDeliveryRates(input);
  // cost per event = cpm / (1000 * rate). Guard every rate: a zero would divide to Infinity and
  // silently turn "unknowable" into "infinitely expensive", which reads as a real verdict.
  const costPerClickCents = ctr > 0 ? cpmCents / (1000 * ctr) : 0;
  const modelledConversionCents = ctr > 0 && cvr > 0 ? cpmCents / (1000 * ctr * cvr) : 0;
  // A real target beats a modelled midpoint. Only the CONVERSION cost is overridden — a target CPA
  // says nothing about what a click or an impression costs in this market, and substituting it
  // there would corrupt the cheaper rungs of the ladder.
  const costPerConversionCents = input.targetCpaCents && input.targetCpaCents > 0 ? input.targetCpaCents : modelledConversionCents;
  return {
    cpmCents,
    costPerClickCents,
    costPerLandingPageViewCents: costPerClickCents / LANDING_PAGE_VIEW_RATE,
    costPerConversionCents,
    costPerInstantFormLeadCents: costPerConversionCents / INSTANT_FORM_LEAD_DISCOUNT,
  };
}

/**
 * Daily budget one ad set needs to be worth creating: enough to clear Meta's rejection floor AND to
 * reach the learning-phase threshold within a week.
 */
export function viablePerAdSetBudgetCents(dailyCostPerConversionCents: number, currency: string | undefined): number {
  const floor = minDailyBudgetCents(currency);
  if (!(dailyCostPerConversionCents > 0)) return floor;
  const learningBudget = (LEARNING_PHASE_CONVERSIONS_PER_WEEK / 7) * dailyCostPerConversionCents;
  return Math.max(floor, Math.round(learningBudget));
}

/**
 * How many audiences (== Meta ad sets) this budget can actually fund.
 *
 * Always at least 1: a campaign with zero ad sets is not a safer campaign, it is a broken one. The
 * caller decides whether 1 is acceptable; this only refuses to pretend the budget stretches further
 * than it does.
 */
export function maxAudiencesForBudget(
  dailyBudgetCents: number,
  currency: string | undefined,
  economics: DeliveryEconomics
): number {
  const perAdSet = viablePerAdSetBudgetCents(economics.costPerConversionCents, currency);
  if (!(dailyBudgetCents > 0) || perAdSet <= 0) return 1;
  return Math.max(1, Math.min(MAX_AUDIENCE_SEGMENTS, Math.floor(dailyBudgetCents / perAdSet)));
}

/** Meta optimisation goals this module will choose between, richest signal first. */
export type ViableOptimizationGoal = "OFFSITE_CONVERSIONS" | "LANDING_PAGE_VIEWS" | "LINK_CLICKS";

export interface OptimizationGoalVerdict {
  goal: ViableOptimizationGoal;
  /** Estimated events per week this goal would produce at this budget. */
  eventsPerWeek: number;
  /** True when the richest goal (website conversions) was affordable and kept. */
  optimal: boolean;
  /** Plain-language reason, safe to show a user. */
  reason: string;
}

/**
 * Picks the richest optimisation goal the budget can actually FEED.
 *
 * Optimising for an event you cannot produce ~50 of per week is worse than optimising for a cheaper
 * one: Meta keeps the ad set in learning, restricts delivery, and the campaign underperforms an
 * honest lower-funnel goal it could have satisfied. So walk down the ladder until a goal clears the
 * threshold, and only then stop.
 *
 * OFFSITE_CONVERSIONS -> LANDING_PAGE_VIEWS -> LINK_CLICKS
 *
 * LINK_CLICKS is the floor: it is always reachable, so this always returns something.
 */
export function resolveViableOptimizationGoal(
  dailyBudgetPerAdSetCents: number,
  economics: DeliveryEconomics
): OptimizationGoalVerdict {
  const weekly = Math.max(0, dailyBudgetPerAdSetCents) * 7;
  const eventsPerWeekAt = (costCents: number) => (costCents > 0 ? weekly / costCents : 0);

  const ladder: Array<{ goal: ViableOptimizationGoal; costCents: number; label: string }> = [
    { goal: "OFFSITE_CONVERSIONS", costCents: economics.costPerConversionCents, label: "website conversions" },
    { goal: "LANDING_PAGE_VIEWS", costCents: economics.costPerLandingPageViewCents, label: "landing page views" },
    { goal: "LINK_CLICKS", costCents: economics.costPerClickCents, label: "link clicks" },
  ];

  for (const [index, rung] of ladder.entries()) {
    const eventsPerWeek = eventsPerWeekAt(rung.costCents);
    const reachesThreshold = eventsPerWeek >= LEARNING_PHASE_CONVERSIONS_PER_WEEK;
    const isLastRung = index === ladder.length - 1;
    if (reachesThreshold || isLastRung) {
      return {
        goal: rung.goal,
        eventsPerWeek: Math.round(eventsPerWeek),
        optimal: index === 0,
        reason:
          index === 0
            ? `Budget supports optimising for ${rung.label} (~${Math.round(eventsPerWeek)}/week, above Meta's ~${LEARNING_PHASE_CONVERSIONS_PER_WEEK}/week learning threshold).`
            : `Optimising for ${rung.label} instead of website conversions: this budget yields roughly ` +
              `${Math.round(eventsPerWeekAt(economics.costPerConversionCents))} conversions/week, below the ` +
              `~${LEARNING_PHASE_CONVERSIONS_PER_WEEK}/week Meta needs to leave the learning phase.`,
      };
    }
  }
  // Unreachable — the loop always returns on the last rung. Kept so the function is total.
  return { goal: "LINK_CLICKS", eventsPerWeek: 0, optimal: false, reason: "Defaulting to link clicks." };
}

/**
 * Below this multiple of the viable per-ad-set budget, narrow interest targeting starves delivery:
 * a small budget spread over a small audience buys too few impressions for Meta to find the people
 * who convert. Broad + Advantage+ lets the algorithm search the whole pool instead.
 */
const BROAD_TARGETING_BUDGET_MULTIPLE = 3;

export function shouldUseBroadTargeting(
  dailyBudgetPerAdSetCents: number,
  currency: string | undefined,
  economics: DeliveryEconomics
): boolean {
  const viable = viablePerAdSetBudgetCents(economics.costPerConversionCents, currency);
  return dailyBudgetPerAdSetCents < viable * BROAD_TARGETING_BUDGET_MULTIPLE;
}

export interface FeasibilityProjection {
  economics: DeliveryEconomics;
  adSets: number;
  goal: OptimizationGoalVerdict;
  broadTargeting: boolean;
  /** Daily budget at which website-conversion optimisation would become viable. */
  budgetForConversionsCents: number;
  /** Human-readable lines, safe to show a user. Empty when nothing needs saying. */
  warnings: string[];
}

/** Symbols for the currencies this platform actually bills in. Anything else falls back to the ISO
 *  code, which is unambiguous if less pretty — never a bare number, because "budget 268/day" in an
 *  unknown currency is exactly the ambiguity that had an INR account reading its rupees as dollars. */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", INR: "₹", JPY: "¥", AUD: "A$", CAD: "C$", SGD: "S$", BRL: "R$", ZAR: "R",
};

/** Formats app-internal cents as whole currency units — budgets here are always wholeUnits * 100,
 *  so this never needs the zero-decimal currency table. */
function money(cents: number, currency: string | undefined): string {
  const code = currency?.trim().toUpperCase();
  const amount = Math.round(cents / 100).toLocaleString("en-US");
  const symbol = code ? CURRENCY_SYMBOLS[code] : undefined;
  if (symbol) return `${symbol}${amount}`;
  return code ? `${amount} ${code}` : amount;
}

/**
 * The pre-spend verdict: what this budget will buy, and what to change if it is not enough.
 *
 * Advisory only — it never blocks a build. The point is that the expected outcome is on screen
 * BEFORE the money is committed, rather than inferred from a disappointing report afterwards.
 */
export function buildFeasibilityProjection(
  dailyBudgetCents: number,
  audiencesRequested: number,
  input: EconomicsInput
): FeasibilityProjection {
  const economics = estimateDeliveryEconomics(input);
  const currency = input.currency;
  const adSets = Math.min(Math.max(1, audiencesRequested), maxAudiencesForBudget(dailyBudgetCents, currency, economics));
  const perAdSet = adSets > 0 ? dailyBudgetCents / adSets : dailyBudgetCents;
  const goal = resolveViableOptimizationGoal(perAdSet, economics);
  const broadTargeting = shouldUseBroadTargeting(perAdSet, currency, economics);
  const budgetForConversionsCents = viablePerAdSetBudgetCents(economics.costPerConversionCents, currency);

  const warnings: string[] = [];

  if (audiencesRequested > adSets) {
    const held = audiencesRequested - adSets;
    const heldNote =
      `The other ${held} ${held === 1 ? "segment is" : "segments are"} saved on the campaign and can be swapped in from the builder.`;
    // Two different reasons produce the same cap, and saying the wrong one is worse than saying
    // nothing: at a large budget the limit is the deliberate ceiling, NOT starvation, and claiming
    // "splitting further would starve them" there is simply false.
    warnings.push(
      adSets >= MAX_AUDIENCE_SEGMENTS
        ? `Using ${adSets} of ${audiencesRequested} audience segments — ${MAX_AUDIENCE_SEGMENTS} is the maximum this ` +
            `platform runs at once, because past that point spend fragments faster than it buys signal. ${heldNote}`
        : `Using ${adSets} of ${audiencesRequested} audience segments. At ${money(dailyBudgetCents, currency)}/day, ` +
            `each ad set needs about ${money(budgetForConversionsCents, currency)}/day to gather enough signal for Meta to ` +
            `optimise — splitting further would leave every one of them starved. ${heldNote}`
    );
  }

  if (!goal.optimal) {
    warnings.push(goal.reason);
    warnings.push(
      `Estimated cost per lead is about ${money(economics.costPerConversionCents, currency)} on the website, ` +
        `or about ${money(economics.costPerInstantFormLeadCents, currency)} with a Meta instant form. ` +
        `To optimise for website conversions directly, budget about ${money(budgetForConversionsCents, currency)}/day per ad set.`
    );
  }

  if (broadTargeting) {
    warnings.push(
      `Targeting broadly (age, location and language only) with Advantage+. At this budget a narrow ` +
        `interest list buys too few impressions for Meta to find the people who convert.`
    );
  }

  return { economics, adSets, goal, broadTargeting, budgetForConversionsCents, warnings };
}

/**
 * The projection for a campaign that already exists, described by what was actually built rather
 * than by what was requested: the distinct audienceNames across its variants ARE its future Meta ad
 * sets (launchMetaHierarchy groups on exactly that), and audiencePool holds everything the strategy
 * produced including the segments the budget could not fund.
 *
 * Best-effort throughout — a workspace with no Meta connection still gets a projection using the
 * USD-equivalent defaults, and any failure yields no warnings rather than failing the build.
 */
export async function buildCampaignFeasibilityWarnings(
  campaign: {
    dailyBudgetCents: number;
    objective?: string;
    locations?: string[];
    networks?: string[];
    audiencePool?: string[];
    targetCpaCents?: number;
    variants: Array<{ audienceName?: string; network: string }>;
  },
  workspaceId: string | undefined,
  resolveCurrency: (workspaceId: string) => Promise<string | undefined>
): Promise<string[]> {
  try {
    const currency = workspaceId ? await resolveCurrency(workspaceId).catch(() => undefined) : undefined;
    const audiencesRequested = campaign.audiencePool?.length ?? new Set(campaign.variants.map((v) => v.audienceName ?? "General Audience")).size;
    const platforms = [...new Set(campaign.variants.map((v) => v.network))].filter(
      (n): n is "meta" | "google" => n === "meta" || n === "google"
    );
    const projection = buildFeasibilityProjection(campaign.dailyBudgetCents, audiencesRequested, {
      objective: campaign.objective,
      platforms,
      countries: campaign.locations,
      currency,
      targetCpaCents: campaign.targetCpaCents,
    });
    return projection.warnings;
  } catch {
    return [];
  }
}
