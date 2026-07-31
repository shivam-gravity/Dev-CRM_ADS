import { isValidObjective, type MetaCampaignObjective } from "./metaObjectives.js";

/**
 * Forward-looking budget/goal simulator for the campaign-generation flow's "drag the budget,
 * preview the outcome" UI. This is a deliberately transparent HEURISTIC, not a real ad-network
 * forecast: it projects the outcome of a budget the user has NOT spent yet, so there are no
 * real conversion values to draw on — revenue is estimated from an assumed average order value
 * (ASSUMED_AOV_CENTS below) and the preview is explicitly labeled `source: "heuristic"`. This is
 * distinct from measured ROAS everywhere else, which now uses real network-reported revenue.
 *
 * Prefer real forecast numbers when they exist: the caller (router) first checks whether the
 * generation job's decisionContext already carries a forecasting-kpi-agent projection and returns
 * that; this heuristic is the fallback for the pre-generation setup screen where no job exists yet.
 */

/** Assumed average order value (cents) for the pre-spend budget PREVIEW only — a hypothetical
 * projection has no real purchase data to use. Not used for any measured/reported ROAS. */
const ASSUMED_AOV_CENTS = 5000;

export interface BudgetSimulationInput {
  objective?: string;
  dailyBudgetCents: number;
  /** Which ad platforms the campaign will run on. The heuristic blends per-platform delivery
   * characteristics (Google search converts richer clicks; Meta buys cheaper, broader reach), so
   * toggling platforms in the UI genuinely moves the preview. Empty/omitted → Meta-only default
   * (the platform the pipeline actually launches on today). */
  platforms?: ("meta" | "google")[];
  /** Target countries. NOW USED: the first recognised country selects the market CPM index below.
   * Previously accepted and silently ignored, while the UI showed a Target Locations picker directly
   * above the projection — so India and the US produced identical numbers despite differing by
   * roughly an order of magnitude in CPM. */
  countries?: string[];
  /** Ad account billing currency (e.g. "INR"). Used as the market fallback when no country matches,
   * because the base rates below are USD-denominated and the BUDGET arrives in account currency. */
  currency?: string;
}

export interface BudgetSimulation {
  estImpressionsPerDay: number;
  estClicks: number;
  estConversions: number;
  /**
   * BUDGET-INVARIANT BY CONSTRUCTION. Budget cancels out:
   *   roas = (budget/cpm * 1000 * ctr * cvr * AOV) / budget = (1000 * ctr * cvr * AOV) / cpm
   * so this is a per-objective/platform/market ASSUMPTION, not a forecast that responds to spend.
   * (Not EXACTLY constant in practice: estConversions is rounded to an integer, so small budgets
   * wobble by the rounding step — that is what makes a tiny budget report a flattering "5x", which
   * is 0.59 conversions rounding up to 1, not a real return.)
   * It was previously presented in a panel captioned "updates live with the objective, budget &
   * platform mix", which was untrue for this field and invited reading a fixed 3.0x as
   * "profitable at any budget". Modelling real diminishing returns would need data we do not have,
   * so the honest fix is to label it rather than invent a curve.
   */
  estRoas: number;
  /** Always "heuristic" here — flags to the UI that this is an estimate, not a network forecast. */
  source: "heuristic";
}

/**
 * Per-objective assumptions. CPM (cost per 1000 impressions, in cents), CTR (click-through rate),
 * and CVR (click→conversion rate) are broad industry-typical midpoints — awareness objectives buy
 * cheap impressions but convert poorly; sales/leads objectives cost more per impression but the
 * clicks they buy convert far better. Kept intentionally coarse; the point is directional feedback
 * as the user drags the budget, not a precise media plan.
 */
const OBJECTIVE_ASSUMPTIONS: Record<MetaCampaignObjective, { cpmCents: number; ctr: number; cvr: number }> = {
  OUTCOME_AWARENESS: { cpmCents: 500, ctr: 0.006, cvr: 0.01 },
  OUTCOME_TRAFFIC: { cpmCents: 900, ctr: 0.012, cvr: 0.02 },
  OUTCOME_ENGAGEMENT: { cpmCents: 700, ctr: 0.015, cvr: 0.015 },
  OUTCOME_LEADS: { cpmCents: 1500, ctr: 0.011, cvr: 0.08 },
  OUTCOME_APP_PROMOTION: { cpmCents: 1300, ctr: 0.01, cvr: 0.05 },
  OUTCOME_SALES: { cpmCents: 1800, ctr: 0.013, cvr: 0.06 },
};

const DEFAULT_ASSUMPTION = OBJECTIVE_ASSUMPTIONS.OUTCOME_TRAFFIC;

/**
 * Market CPM index, relative to the USD-denominated base rates above.
 *
 * WHY THIS IS NEEDED: `dailyBudgetCents` arrives in the AD ACCOUNT'S OWN CURRENCY (always
 * wholeUnits * 100), but the CPM constants above are US dollar figures — $15 CPM for leads is a
 * normal US number. Dividing a rupee budget by a dollar CPM is a category error: on an INR account
 * the preview read a ~Rs13.50 CPM and so overstated delivery by roughly an order of magnitude,
 * promising 3,703 impressions and 3 conversions/day for Rs50 (about $0.60).
 *
 * The index therefore expresses "CPM in THIS market, denominated in THIS market's currency, divided
 * by the USD figure" — it folds the currency denomination and the real cost difference together,
 * which is the only ratio that matters once the budget is already in local units.
 *
 * IN is anchored on REAL MEASURED DATA, not a guess: a live INR ad account reported
 * spend Rs499.78 over 16,743 impressions = Rs29.85 CPM, against the model's Rs13.50 -> 2.2x.
 * (Its measured CTR, 1.34%, was close to the model's 1.1%, so only CPM is corrected here.)
 *
 * Every other entry is a rough order-of-magnitude placeholder and is deliberately marked as such.
 * Unknown market -> 1 (behaves exactly as before), so this can only improve a known market and
 * never silently distorts an unknown one.
 */
const MARKET_CPM_INDEX: Record<string, number> = {
  // Measured.
  IN: 2.2, INR: 2.2,
  // Baseline the constants were written against.
  US: 1, USD: 1,
  // Rough placeholders — same order of magnitude as the US, pending real measurement.
  GB: 0.9, GBP: 0.9,
  CA: 0.8, CAD: 0.8,
  AU: 0.9, AUD: 0.9,
  EU: 0.85, EUR: 0.85,
  // Lower-CPM markets in local-currency terms; placeholders until measured.
  BR: 3, BRL: 3,
  MX: 12, MXN: 12,
  ID: 900, IDR: 900,
  PH: 35, PHP: 35,
  JP: 90, JPY: 90,
};

/** ISO-ish lookup for the handful of country NAMES the location picker produces. */
const COUNTRY_NAME_TO_INDEX_KEY: Record<string, string> = {
  india: "IN",
  "united states": "US",
  "united kingdom": "GB",
  canada: "CA",
  australia: "AU",
  brazil: "BR",
  mexico: "MX",
  indonesia: "ID",
  philippines: "PH",
  japan: "JP",
};

/**
 * Resolve the market multiplier: an explicitly targeted country wins over the account currency,
 * because a USD-billed account can perfectly well be buying Indian impressions.
 */
function resolveMarketIndex(countries: string[] | undefined, currency: string | undefined): number {
  for (const raw of countries ?? []) {
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    const key = /^[A-Za-z]{2}$/.test(trimmed) ? trimmed.toUpperCase() : COUNTRY_NAME_TO_INDEX_KEY[trimmed.toLowerCase()];
    if (key && MARKET_CPM_INDEX[key] !== undefined) return MARKET_CPM_INDEX[key];
  }
  const code = currency?.trim().toUpperCase();
  if (code && MARKET_CPM_INDEX[code] !== undefined) return MARKET_CPM_INDEX[code];
  return 1;
}

/**
 * Per-platform MULTIPLIERS applied on top of the objective's base CPM/CTR/CVR — broad, directional
 * midpoints, not a media plan. Google (search-led) buys pricier impressions but its intent-driven
 * clicks convert better; Meta (feed-led) buys cheap, broad reach that clicks more but converts
 * lower. When BOTH platforms are selected we average their multipliers (an even budget split), so
 * the combined preview sits between the two — which is why toggling a platform now visibly moves
 * the numbers instead of doing nothing. Kept as multipliers (not absolute values) so the objective
 * assumptions above stay the single source of base rates.
 */
const PLATFORM_MULTIPLIERS: Record<"meta" | "google", { cpm: number; ctr: number; cvr: number }> = {
  meta: { cpm: 0.9, ctr: 1.0, cvr: 0.9 },
  google: { cpm: 1.25, ctr: 1.35, cvr: 1.4 },
};

/** Turns objective + daily budget + platform mix into an estimated daily impressions/clicks/
 * conversions/ROAS preview. Platform selection blends the multipliers above. */
export function simulateBudget(input: BudgetSimulationInput): BudgetSimulation {
  const budgetCents = Math.max(0, input.dailyBudgetCents || 0);
  const base =
    input.objective && isValidObjective(input.objective)
      ? OBJECTIVE_ASSUMPTIONS[input.objective]
      : DEFAULT_ASSUMPTION;

  // Blend the selected platforms' multipliers (empty/unknown → Meta-only, the current launch
  // default). Averaging models an even budget split across the chosen platforms.
  const selected = (input.platforms ?? []).filter((p): p is "meta" | "google" => p === "meta" || p === "google");
  const platforms = selected.length > 0 ? selected : (["meta"] as const);
  const mult = platforms.reduce(
    (acc, p) => ({ cpm: acc.cpm + PLATFORM_MULTIPLIERS[p].cpm, ctr: acc.ctr + PLATFORM_MULTIPLIERS[p].ctr, cvr: acc.cvr + PLATFORM_MULTIPLIERS[p].cvr }),
    { cpm: 0, ctr: 0, cvr: 0 }
  );
  // Market index applied to CPM only: CTR/CVR are behavioural rates that travel far better across
  // markets than price does (the measured INR account's 1.34% CTR is close to the model's 1.1%).
  const marketIndex = resolveMarketIndex(input.countries, input.currency);
  const cpmCents = base.cpmCents * (mult.cpm / platforms.length) * marketIndex;
  const ctr = base.ctr * (mult.ctr / platforms.length);
  const cvr = base.cvr * (mult.cvr / platforms.length);

  const estImpressionsPerDay = cpmCents > 0 ? Math.round((budgetCents / cpmCents) * 1000) : 0;
  const estClicks = Math.round(estImpressionsPerDay * ctr);
  const estConversions = Math.round(estClicks * cvr);
  const estRevenueCents = estConversions * ASSUMED_AOV_CENTS;
  const estRoas = budgetCents > 0 ? Number((estRevenueCents / budgetCents).toFixed(2)) : 0;

  return { estImpressionsPerDay, estClicks, estConversions, estRoas, source: "heuristic" };
}
