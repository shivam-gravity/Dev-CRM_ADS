import { test } from "node:test";
import assert from "node:assert";
import { simulateBudget } from "../modules/adapters/budgetSimulator.js";

const BUDGET = 3500; // $35/day in cents

test("simulateBudget - scales impressions with budget (more budget → more impressions)", () => {
  const low = simulateBudget({ objective: "OUTCOME_TRAFFIC", dailyBudgetCents: 1000, platforms: ["meta"] });
  const high = simulateBudget({ objective: "OUTCOME_TRAFFIC", dailyBudgetCents: 10000, platforms: ["meta"] });
  assert.ok(high.estImpressionsPerDay > low.estImpressionsPerDay);
});

test("simulateBudget - platform mix genuinely changes impressions (Google ≠ Meta ≠ both)", () => {
  const meta = simulateBudget({ objective: "OUTCOME_SALES", dailyBudgetCents: BUDGET, platforms: ["meta"] });
  const google = simulateBudget({ objective: "OUTCOME_SALES", dailyBudgetCents: BUDGET, platforms: ["google"] });
  const both = simulateBudget({ objective: "OUTCOME_SALES", dailyBudgetCents: BUDGET, platforms: ["meta", "google"] });

  // Meta buys cheaper, broader reach → more impressions than pricier Google.
  assert.ok(meta.estImpressionsPerDay > google.estImpressionsPerDay, "Meta should yield more impressions than Google at equal budget");
  // Both-platforms blends strictly between the two single-platform extremes.
  assert.ok(
    both.estImpressionsPerDay < meta.estImpressionsPerDay && both.estImpressionsPerDay > google.estImpressionsPerDay,
    "combined preview should sit between the two single-platform values"
  );
});

test("simulateBudget - Google's intent-driven clicks convert to higher ROAS than Meta (at a budget where rounding doesn't flatten it)", () => {
  // Uses a larger budget so estConversions isn't rounded to the same small integer for both — at
  // $35/day both round to ~2 conversions and the ROAS difference is invisible; at $500/day the
  // richer Google conversion rate shows through.
  const meta = simulateBudget({ objective: "OUTCOME_SALES", dailyBudgetCents: 50000, platforms: ["meta"] });
  const google = simulateBudget({ objective: "OUTCOME_SALES", dailyBudgetCents: 50000, platforms: ["google"] });
  assert.ok(google.estRoas > meta.estRoas, `Google ROAS (${google.estRoas}) should beat Meta (${meta.estRoas})`);
});

test("simulateBudget - empty/omitted platforms defaults to Meta-only (the current launch default)", () => {
  const omitted = simulateBudget({ objective: "OUTCOME_LEADS", dailyBudgetCents: BUDGET });
  const empty = simulateBudget({ objective: "OUTCOME_LEADS", dailyBudgetCents: BUDGET, platforms: [] });
  const meta = simulateBudget({ objective: "OUTCOME_LEADS", dailyBudgetCents: BUDGET, platforms: ["meta"] });
  assert.deepStrictEqual(omitted, meta);
  assert.deepStrictEqual(empty, meta);
});

test("simulateBudget - objective still matters (awareness buys more impressions than sales at equal budget)", () => {
  const awareness = simulateBudget({ objective: "OUTCOME_AWARENESS", dailyBudgetCents: BUDGET, platforms: ["meta"] });
  const sales = simulateBudget({ objective: "OUTCOME_SALES", dailyBudgetCents: BUDGET, platforms: ["meta"] });
  assert.ok(awareness.estImpressionsPerDay > sales.estImpressionsPerDay);
});

test("simulateBudget - zero budget yields zeros, never NaN/Infinity", () => {
  const sim = simulateBudget({ objective: "OUTCOME_TRAFFIC", dailyBudgetCents: 0, platforms: ["meta", "google"] });
  assert.strictEqual(sim.estImpressionsPerDay, 0);
  assert.strictEqual(sim.estClicks, 0);
  assert.strictEqual(sim.estConversions, 0);
  assert.strictEqual(sim.estRoas, 0);
});

test("simulateBudget - ignores unknown platform strings, falling back to the Meta default", () => {
  const bogus = simulateBudget({ objective: "OUTCOME_TRAFFIC", dailyBudgetCents: BUDGET, platforms: ["tiktok" as unknown as "meta"] });
  const meta = simulateBudget({ objective: "OUTCOME_TRAFFIC", dailyBudgetCents: BUDGET, platforms: ["meta"] });
  assert.deepStrictEqual(bogus, meta);
});

// ── Market-aware CPM (added after auditing the "ballpark projection" panel) ──

test("simulateBudget - the target MARKET scales CPM; geo used to be accepted and ignored", () => {
  const base = { objective: "OUTCOME_LEADS", dailyBudgetCents: 5000, platforms: ["meta"] as ("meta" | "google")[] };
  const india = simulateBudget({ ...base, countries: ["India"] });
  const us = simulateBudget({ ...base, countries: ["United States"] });

  // Before this, India / US / Japan all returned an identical 3704 impressions, despite the card
  // showing a Target Locations picker directly above the number.
  assert.notStrictEqual(india.estImpressionsPerDay, us.estImpressionsPerDay, "market must change the projection");
  // India's CPM index is anchored on a real measured INR account (Rs29.85 CPM vs the model's
  // Rs13.50 = 2.2x), so the same budget must buy proportionally FEWER impressions than the US
  // baseline the constants were written against.
  assert.ok(india.estImpressionsPerDay < us.estImpressionsPerDay, "a higher local CPM must buy fewer impressions");
  assert.ok(Math.abs(us.estImpressionsPerDay / india.estImpressionsPerDay - 2.2) < 0.05, "should track the measured 2.2x index");
});

test("simulateBudget - the ACCOUNT CURRENCY is the market fallback when no country is given", () => {
  const withCurrency = simulateBudget({ objective: "OUTCOME_LEADS", dailyBudgetCents: 5000, platforms: ["meta"], currency: "INR" });
  const withCountry = simulateBudget({ objective: "OUTCOME_LEADS", dailyBudgetCents: 5000, platforms: ["meta"], countries: ["India"] });
  assert.strictEqual(withCurrency.estImpressionsPerDay, withCountry.estImpressionsPerDay);
});

test("simulateBudget - an explicit country BEATS the account currency (a USD account can buy Indian impressions)", () => {
  const usdAccountTargetingIndia = simulateBudget({ objective: "OUTCOME_LEADS", dailyBudgetCents: 5000, platforms: ["meta"], countries: ["India"], currency: "USD" });
  const india = simulateBudget({ objective: "OUTCOME_LEADS", dailyBudgetCents: 5000, platforms: ["meta"], countries: ["India"] });
  assert.strictEqual(usdAccountTargetingIndia.estImpressionsPerDay, india.estImpressionsPerDay);
});

test("simulateBudget - an unknown market behaves exactly as before (index 1), never silently distorted", () => {
  const unknown = simulateBudget({ objective: "OUTCOME_LEADS", dailyBudgetCents: 5000, platforms: ["meta"], countries: ["Atlantis"], currency: "XYZ" });
  const baseline = simulateBudget({ objective: "OUTCOME_LEADS", dailyBudgetCents: 5000, platforms: ["meta"], countries: ["United States"] });
  assert.strictEqual(unknown.estImpressionsPerDay, baseline.estImpressionsPerDay);
});

test("simulateBudget - estRoas is BUDGET-INVARIANT, which is why it must not be sold as budget-sensitive", () => {
  // Budget cancels out of the formula, so this is an assumption, not a forecast. Documented on the
  // type and relabelled in the UI ("assumed ROAS") rather than papered over with an invented curve.
  const small = simulateBudget({ objective: "OUTCOME_LEADS", dailyBudgetCents: 50_000, platforms: ["meta"], countries: ["India"] });
  const large = simulateBudget({ objective: "OUTCOME_LEADS", dailyBudgetCents: 5_000_000, platforms: ["meta"], countries: ["India"] });
  // Invariant in the FORMULA, but estConversions is Math.round-ed, so small budgets wobble by the
  // rounding step (measured 1.3 vs 1.33). That rounding is also what produced an eye-catching "5x"
  // at a Rs10 budget — 0.59 conversions rounding up to 1 — which reads as a great return and is
  // really just integer division. Assert near-invariance rather than pretending it is exact.
  assert.ok(Math.abs(small.estRoas - large.estRoas) < 0.1, `estRoas must not meaningfully vary with budget, got ${small.estRoas} vs ${large.estRoas}`);
  // ...while the volume metrics genuinely do scale with spend.
  assert.ok(large.estImpressionsPerDay > small.estImpressionsPerDay * 50, "impressions must scale with budget");
});
