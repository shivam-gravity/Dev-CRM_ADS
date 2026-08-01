import { test } from "node:test";
import assert from "node:assert";
import {
  conversionEventMismatchError,
  defaultConversionEventForObjective,
  isConversionEventValidForObjective,
  listConversionEventsForObjective,
  listObjectives,
  normalizeConversionEvent,
} from "../modules/adapters/metaObjectives.js";

// The cases below are not hypothetical — each pairing was observed on the live Polluxa ad account
// (act_599119536434454). Meta rejects a crossed pair at AD SET creation with "Conversion event
// unavailable: This conversion event isn't available with the objective that you selected", which
// lands AFTER the campaign container is created, so every variant fails and an empty campaign shell
// is orphaned in the account.

test("rejects the crossed pairs that failed in production", () => {
  // C-0013: builder defaulted the conversion event to PURCHASE while the goal was Leads.
  // 4 variants, all failed, campaign container 120256431894490771 left behind.
  assert.strictEqual(isConversionEventValidForObjective("OUTCOME_LEADS", "PURCHASE"), false);
  // Same failure in the opposite direction, on a different campaign.
  assert.strictEqual(isConversionEventValidForObjective("OUTCOME_SALES", "LEAD"), false);
});

test("accepts the pairs that published successfully", () => {
  assert.strictEqual(isConversionEventValidForObjective("OUTCOME_SALES", "PURCHASE"), true);
  assert.strictEqual(isConversionEventValidForObjective("OUTCOME_LEADS", "LEAD"), true);
});

test("leaves unconstrained objectives alone", () => {
  // OUTCOME_TRAFFIC with a pixel + PURCHASE publishes fine on this same account, so the guard must
  // not reject it. Absence from the map is deliberate, not an oversight — asserted so a later edit
  // that "completes" the table has to fail this test first.
  assert.strictEqual(listConversionEventsForObjective("OUTCOME_TRAFFIC"), null);
  assert.strictEqual(isConversionEventValidForObjective("OUTCOME_TRAFFIC", "PURCHASE"), true);
});

test("events shared by both funnels stay valid for both", () => {
  for (const event of ["COMPLETE_REGISTRATION", "SUBSCRIBE", "START_TRIAL", "DONATE"]) {
    assert.strictEqual(isConversionEventValidForObjective("OUTCOME_SALES", event), true, `SALES/${event}`);
    assert.strictEqual(isConversionEventValidForObjective("OUTCOME_LEADS", event), true, `LEADS/${event}`);
  }
});

test("the two conversion funnels do not share their defining event", () => {
  const sales = listConversionEventsForObjective("OUTCOME_SALES")!;
  const leads = listConversionEventsForObjective("OUTCOME_LEADS")!;
  assert.ok(sales.includes("PURCHASE") && !leads.includes("PURCHASE"));
  assert.ok(leads.includes("LEAD") && !sales.includes("LEAD"));
});

test("default event is the objective's canonical one", () => {
  assert.strictEqual(defaultConversionEventForObjective("OUTCOME_SALES"), "PURCHASE");
  assert.strictEqual(defaultConversionEventForObjective("OUTCOME_LEADS"), "LEAD");
  // Unconstrained objective has no default to offer.
  assert.strictEqual(defaultConversionEventForObjective("OUTCOME_TRAFFIC"), undefined);
});

test("event matching is case-insensitive", () => {
  assert.strictEqual(isConversionEventValidForObjective("OUTCOME_LEADS", "lead"), true);
  assert.strictEqual(isConversionEventValidForObjective("OUTCOME_LEADS", "purchase"), false);
});

test("unknown objectives are unconstrained rather than rejected", () => {
  // metaObjective falls back to a valid default before the guard runs, but a free-text value must
  // never hard-fail a launch here.
  assert.strictEqual(isConversionEventValidForObjective("NOT_AN_OBJECTIVE", "PURCHASE"), true);
});

test("normalises the two pickers' disagreeing case to the Graph enum", () => {
  // PromotionObjectiveCard historically sent "purchase"; CampaignBuilder sent "PURCHASE".
  assert.strictEqual(normalizeConversionEvent("purchase"), "PURCHASE");
  assert.strictEqual(normalizeConversionEvent("  Lead  "), "LEAD");
});

test("mismatch error names the objective and the events that would work", () => {
  const err = conversionEventMismatchError("OUTCOME_LEADS", "PURCHASE");
  assert.ok(err, "expected an error for the C-0013 pairing");
  assert.match(err!, /PURCHASE/);
  assert.match(err!, /OUTCOME_LEADS/);
  assert.match(err!, /Leads/); // human label
  assert.match(err!, /LEAD/); // at least one usable alternative
  // A valid pair produces no error at all.
  assert.strictEqual(conversionEventMismatchError("OUTCOME_SALES", "PURCHASE"), null);
  // Case-insensitive on the way in, normalised in the message.
  assert.match(conversionEventMismatchError("OUTCOME_LEADS", "purchase")!, /PURCHASE is not available/);
});

test("the objectives endpoint ships the rules the picker filters on", () => {
  const objectives = listObjectives();
  const leads = objectives.find((o) => o.value === "OUTCOME_LEADS")!;
  const traffic = objectives.find((o) => o.value === "OUTCOME_TRAFFIC")!;
  assert.ok(leads.conversionEvents?.includes("LEAD"));
  assert.ok(!leads.conversionEvents?.includes("PURCHASE"));
  assert.strictEqual(traffic.conversionEvents, null);
});
