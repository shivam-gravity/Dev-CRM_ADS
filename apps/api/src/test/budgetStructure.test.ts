import { test } from "node:test";
import assert from "node:assert";
import {
  LEARNING_PHASE_CONVERSIONS_PER_WEEK,
  MAX_AUDIENCE_SEGMENTS,
  buildFeasibilityProjection,
  estimateDeliveryEconomics,
  maxAudiencesForBudget,
  resolveViableOptimizationGoal,
  shouldUseBroadTargeting,
  viablePerAdSetBudgetCents,
} from "../modules/orchestrator/budgetStructure.js";

// C-0013's real configuration: Rs100/day, Leads, Meta, India, INR account.
const C0013 = { objective: "OUTCOME_LEADS", platforms: ["meta"] as ("meta" | "google")[], countries: ["India"], currency: "INR" };
const RS = (rupees: number) => rupees * 100; // app-internal cents are always wholeUnits * 100

test("delivery economics stay anchored on the measured INR account", () => {
  const econ = estimateDeliveryEconomics(C0013);
  // The live account measured Rs29.85 CPM; the model must not drift far from what was observed, or
  // every downstream budget decision is built on a number that never matched reality.
  assert.ok(econ.cpmCents > 2900 && econ.cpmCents < 3100, `CPM ${econ.cpmCents} cents should be ~Rs29-31`);
  // Ordering is the invariant that matters: a click is cheaper than a landing page view (some
  // clicks bounce), which is cheaper than a completed conversion.
  assert.ok(econ.costPerClickCents < econ.costPerLandingPageViewCents);
  assert.ok(econ.costPerLandingPageViewCents < econ.costPerConversionCents);
  // An on-Meta form lead is materially cheaper than a website conversion — the whole reason it is
  // the right structure for a small budget.
  assert.ok(econ.costPerInstantFormLeadCents < econ.costPerConversionCents);
});

test("a user's target CPA overrides the modelled one", () => {
  const modelled = estimateDeliveryEconomics(C0013);
  const targeted = estimateDeliveryEconomics({ ...C0013, targetCpaCents: RS(500) });
  assert.strictEqual(targeted.costPerConversionCents, RS(500));
  // Only the conversion cost is overridden — a target CPA says nothing about click or impression
  // prices, and substituting it there would corrupt the cheaper rungs of the ladder.
  assert.strictEqual(targeted.costPerClickCents, modelled.costPerClickCents);
  assert.strictEqual(targeted.cpmCents, modelled.cpmCents);
});

test("Rs100/day funds exactly one audience, not the four that were generated", () => {
  const econ = estimateDeliveryEconomics(C0013);
  assert.strictEqual(maxAudiencesForBudget(RS(100), "INR", econ), 1);
});

test("audience count scales with budget and stops at the ceiling", () => {
  const econ = estimateDeliveryEconomics(C0013);
  const perAdSet = viablePerAdSetBudgetCents(econ.costPerConversionCents, "INR");
  assert.strictEqual(maxAudiencesForBudget(perAdSet * 2, "INR", econ), 2);
  assert.strictEqual(maxAudiencesForBudget(perAdSet * 3, "INR", econ), 3);
  // Ceiling holds no matter how large the budget gets — past this, spend fragments faster than it
  // buys signal.
  assert.strictEqual(maxAudiencesForBudget(perAdSet * 50, "INR", econ), MAX_AUDIENCE_SEGMENTS);
});

test("never returns zero audiences — a campaign with no ad sets is broken, not safe", () => {
  const econ = estimateDeliveryEconomics(C0013);
  for (const budget of [0, -1, 1]) {
    assert.strictEqual(maxAudiencesForBudget(budget, "INR", econ), 1, `budget ${budget}`);
  }
});

test("the viable per-ad-set budget clears BOTH floors", () => {
  const econ = estimateDeliveryEconomics(C0013);
  const viable = viablePerAdSetBudgetCents(econ.costPerConversionCents, "INR");
  // Meta's rejection floor for INR.
  assert.ok(viable >= RS(100), "must clear Meta's per-ad-set minimum");
  // And the learning-phase floor, which is the one that actually decides whether it works.
  assert.ok(viable >= (LEARNING_PHASE_CONVERSIONS_PER_WEEK / 7) * econ.costPerConversionCents - 1);
  // A currency with no known minimum still gets the learning floor rather than falling to zero.
  assert.ok(viablePerAdSetBudgetCents(econ.costPerConversionCents, undefined) > 0);
  // With no usable CPA estimate it degrades to the rejection floor instead of NaN/Infinity.
  assert.strictEqual(viablePerAdSetBudgetCents(0, "INR"), RS(100));
});

test("Rs100/day cannot feed website conversions, so the goal steps down", () => {
  const econ = estimateDeliveryEconomics(C0013);
  const verdict = resolveViableOptimizationGoal(RS(100), econ);
  assert.notStrictEqual(verdict.goal, "OFFSITE_CONVERSIONS");
  assert.strictEqual(verdict.optimal, false);
  assert.match(verdict.reason, /learning phase/i);
  // Whatever it steps down to must itself clear the threshold, or the step was pointless.
  assert.ok(verdict.eventsPerWeek >= LEARNING_PHASE_CONVERSIONS_PER_WEEK);
});

test("a budget that CAN feed conversions keeps them", () => {
  const econ = estimateDeliveryEconomics(C0013);
  const viable = viablePerAdSetBudgetCents(econ.costPerConversionCents, "INR");
  const verdict = resolveViableOptimizationGoal(viable, econ);
  assert.strictEqual(verdict.goal, "OFFSITE_CONVERSIONS");
  assert.strictEqual(verdict.optimal, true);
});

test("the ladder always returns something, even at an absurd budget", () => {
  const econ = estimateDeliveryEconomics(C0013);
  const verdict = resolveViableOptimizationGoal(1, econ);
  assert.ok(["OFFSITE_CONVERSIONS", "LANDING_PAGE_VIEWS", "LINK_CLICKS"].includes(verdict.goal));
});

test("thin budgets target broadly; large ones may narrow", () => {
  const econ = estimateDeliveryEconomics(C0013);
  const viable = viablePerAdSetBudgetCents(econ.costPerConversionCents, "INR");
  assert.strictEqual(shouldUseBroadTargeting(RS(100), "INR", econ), true);
  assert.strictEqual(shouldUseBroadTargeting(viable * 10, "INR", econ), false);
});

test("the C-0013 projection explains the cap, the goal and the cost", () => {
  const p = buildFeasibilityProjection(RS(100), 4, C0013);
  assert.strictEqual(p.adSets, 1);
  assert.strictEqual(p.goal.optimal, false);
  assert.strictEqual(p.broadTargeting, true);
  const text = p.warnings.join(" ");
  assert.match(text, /1 of 4 audience segments/);
  assert.match(text, /saved on the campaign/, "the user must know the other segments are not lost");
  assert.match(text, /instant form/, "the cheaper alternative has to be named, not just the problem");
  assert.match(text, /₹/, "amounts must carry the account's currency, not a bare number");
});

test("a large budget explains the cap as the ceiling, not as starvation", () => {
  // Saying "splitting further would starve them" at Rs50,000/day is simply false, and a wrong
  // reason is worse than no reason.
  const p = buildFeasibilityProjection(RS(50_000), 4, C0013);
  assert.strictEqual(p.adSets, MAX_AUDIENCE_SEGMENTS);
  const text = p.warnings.join(" ");
  assert.match(text, /maximum this platform runs at once/);
  assert.doesNotMatch(text, /starved/);
});

test("a well-funded campaign that needs no changes says nothing", () => {
  const econ = estimateDeliveryEconomics(C0013);
  const viable = viablePerAdSetBudgetCents(econ.costPerConversionCents, "INR");
  // One audience, budget far above the viable floor: nothing was capped, nothing stepped down,
  // targeting stays narrow — so there is no advice worth interrupting the user with.
  const p = buildFeasibilityProjection(viable * 10, 1, C0013);
  assert.deepStrictEqual(p.warnings, []);
});

test("USD accounts get the same treatment at their own scale", () => {
  const usd = { ...C0013, countries: ["United States"], currency: "USD" };
  const econ = estimateDeliveryEconomics(usd);
  // $1/day is Meta's USD floor but nowhere near the learning threshold.
  assert.strictEqual(maxAudiencesForBudget(100, "USD", econ), 1);
  const viable = viablePerAdSetBudgetCents(econ.costPerConversionCents, "USD");
  assert.ok(viable > 100, "the learning floor must exceed the $1 rejection floor");
  assert.strictEqual(maxAudiencesForBudget(viable * 3, "USD", econ), 3);
});

test("an unknown currency falls back to the USD-equivalent floor rather than failing", () => {
  const econ = estimateDeliveryEconomics({ ...C0013, currency: "ZZZ" });
  assert.ok(maxAudiencesForBudget(RS(100), "ZZZ", econ) >= 1);
  assert.ok(viablePerAdSetBudgetCents(econ.costPerConversionCents, "ZZZ") >= 100);
});
