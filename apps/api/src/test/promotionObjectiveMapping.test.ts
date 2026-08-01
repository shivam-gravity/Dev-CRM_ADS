import { test, after } from "node:test";
import assert from "node:assert";
import { disconnectTestInfra } from "./testUtils/disconnectInfra.js";
import {
  BUSINESS_TYPE_DEFAULT_EVENT,
  SHORT_TERM_PROMOTION_DAYS,
  resolveConversionEventForBuild,
  resolvePromotionEndDate,
} from "../modules/orchestrator/deferredCampaignBuild.js";
import { conversionEventMismatchError } from "../modules/adapters/metaObjectives.js";

/**
 * Every control on the Promotion Objective card has to change the campaign that gets built, or it
 * is decoration. Two of them were: businessType and promotionType were held in the card's state and
 * never included in the values handed to the parent, so picking "Online Shopping" or "Short-term"
 * produced a byte-identical campaign.
 */

// deferredCampaignBuild reaches Prisma, BullMQ and the Redis-backed lock at import time, so the
// process would keep those handles open and node --test would hang after the last assertion.
after(disconnectTestInfra);

test("business type fills the conversion event the user left blank", () => {
  // "Solution & Online Service" sells a lead, not a purchase — this is the pairing whose absence
  // let C-0013 default to PURCHASE on a Leads objective.
  assert.strictEqual(resolveConversionEventForBuild("OUTCOME_LEADS", undefined, "solution_service"), "LEAD");
  assert.strictEqual(resolveConversionEventForBuild("OUTCOME_SALES", undefined, "online_shopping"), "PURCHASE");
  assert.strictEqual(resolveConversionEventForBuild("OUTCOME_LEADS", undefined, "local_store"), "CONTACT");
});

test("an explicit pick always beats the business-type default", () => {
  assert.strictEqual(resolveConversionEventForBuild("OUTCOME_SALES", "ADD_TO_CART", "online_shopping"), "ADD_TO_CART");
});

test("a default the objective cannot carry is dropped, not forced through", () => {
  // online_shopping defaults to PURCHASE, which OUTCOME_LEADS rejects. Failing the build over a
  // value the user never chose would be indefensible, so it yields nothing instead.
  assert.ok(conversionEventMismatchError("OUTCOME_LEADS", "PURCHASE"), "precondition: this pair is invalid");
  assert.strictEqual(resolveConversionEventForBuild("OUTCOME_LEADS", undefined, "online_shopping"), undefined);
});

test("every business-type default is a real, usable event", () => {
  for (const [businessType, event] of Object.entries(BUSINESS_TYPE_DEFAULT_EVENT)) {
    // Each default must be valid for at least one conversion objective, or it could never apply.
    const usable =
      !conversionEventMismatchError("OUTCOME_SALES", event) || !conversionEventMismatchError("OUTCOME_LEADS", event);
    assert.ok(usable, `${businessType} → ${event} is not valid for either conversion objective`);
  }
});

test("unknown or missing business type simply contributes nothing", () => {
  assert.strictEqual(resolveConversionEventForBuild("OUTCOME_SALES", undefined, "spaceship_dealership"), undefined);
  assert.strictEqual(resolveConversionEventForBuild("OUTCOME_SALES", undefined, undefined), undefined);
});

test("short-term promotions get an end date; long-term ones do not", () => {
  const now = Date.UTC(2026, 7, 2);
  const end = resolvePromotionEndDate("short_term", undefined, now);
  assert.ok(end, "short-term must end at some point — that is the only thing that makes it short");
  const days = (Date.parse(end!) - now) / (24 * 60 * 60 * 1000);
  assert.strictEqual(days, SHORT_TERM_PROMOTION_DAYS);

  // Long-term is the running-until-stopped case, so it must NOT invent an end date.
  assert.strictEqual(resolvePromotionEndDate("long_term", undefined, now), undefined);
  assert.strictEqual(resolvePromotionEndDate(undefined, undefined, now), undefined);
});

test("an end date the user already set is never overwritten", () => {
  const existing = "2026-12-31T00:00:00.000Z";
  assert.strictEqual(resolvePromotionEndDate("short_term", existing, Date.UTC(2026, 7, 2)), undefined);
});
