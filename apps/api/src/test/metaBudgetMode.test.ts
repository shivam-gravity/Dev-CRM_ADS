import { test } from "node:test";
import assert from "node:assert";

// Same reason as metaAdapter.test.ts: cleared before the first import so live credentials leaking
// from another test file's dotenv side effect cannot flip this file out of its assumptions.
delete process.env.META_ACCESS_TOKEN;
delete process.env.META_AD_ACCOUNT_ID;

const { metaAdapter, minDailyBudgetCents } = await import("../modules/adapters/metaAdapter.js");

const INR_CREDS = { accessToken: "tok", adAccountId: "act_1", currency: "INR", pageId: "page_1" } as const;

/**
 * Publishes C-0013's exact shape (Rs100/day across 4 audiences on an INR account) in the given mode
 * and returns the total daily spend Meta would actually be asked for.
 */
async function totalDailySpendCents(budgetMode: "ABO" | "CBO", campaignDailyBudgetCents: number, adSetCount: number) {
  const original = global.fetch;
  let campaignBudget = 0;
  let adSetBudget = 0;
  global.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(url).includes("/adsets")) adSetBudget += body.daily_budget ?? 0;
    else if (String(url).includes("/campaigns")) campaignBudget += body.daily_budget ?? 0;
    return { ok: true, json: async () => ({ id: "obj_1" }) } as Response;
  }) as typeof fetch;
  try {
    // Mirrors launchCampaignInner: the campaign budget is split evenly across variants first.
    const perVariant = Math.floor(campaignDailyBudgetCents / adSetCount);
    await metaAdapter.createCampaignContainer!(
      { name: "C", objective: "OUTCOME_LEADS", budgetMode, dailyBudgetCents: campaignDailyBudgetCents },
      INR_CREDS as any
    );
    for (let i = 0; i < adSetCount; i++) {
      await metaAdapter.createAdSetContainer!(
        { campaignExternalId: "camp_1", name: `AS${i}`, dailyBudgetCents: perVariant, budgetMode, targeting: {} },
        INR_CREDS as any
      );
    }
    return campaignBudget + adSetBudget;
  } finally {
    global.fetch = original;
  }
}

test("minDailyBudgetCents is currency-scaled, not a flat number", () => {
  assert.strictEqual(minDailyBudgetCents("INR"), 10000); // Rs100/day
  assert.strictEqual(minDailyBudgetCents("USD"), 100); // $1/day
  assert.strictEqual(minDailyBudgetCents("inr"), 10000, "case-insensitive");
  assert.strictEqual(minDailyBudgetCents(undefined), 100, "unknown currency falls back to the USD equivalent");
  assert.strictEqual(minDailyBudgetCents("ZZZ"), 100);
});

// This is the arithmetic that makes CBO the default in launchMetaHierarchy. ABO floors EVERY ad set
// to the per-currency minimum, so the floor multiplies by the ad set count and the campaign quietly
// spends several times what was asked for. Observed on C-0013: Rs100/day requested, Rs400/day
// published across 4 audiences.
test("ABO multiplies a below-floor budget by the ad set count", async () => {
  const total = await totalDailySpendCents("ABO", 100 * 100, 4);
  assert.strictEqual(total, 4 * 10000, "4 ad sets each floored to the Rs100 INR minimum");
});

test("CBO honours the requested budget exactly, whatever the ad set count", async () => {
  for (const adSetCount of [1, 4, 16]) {
    const total = await totalDailySpendCents("CBO", 100 * 100, adSetCount);
    assert.strictEqual(total, 10000, `Rs100/day stays Rs100/day across ${adSetCount} ad sets`);
  }
});

test("CBO and ABO agree when there is only one ad set", async () => {
  // With a single ad set there is nothing to multiply, so the two modes cost the same — the
  // divergence is created by splitting, not by the mode itself.
  const abo = await totalDailySpendCents("ABO", 100 * 100, 1);
  const cbo = await totalDailySpendCents("CBO", 100 * 100, 1);
  assert.strictEqual(abo, cbo);
});

test("a budget already above the floor is never inflated", async () => {
  // Rs2000/day over 4 ad sets is Rs500 each, comfortably above the Rs100 floor — ABO should pass it
  // through untouched, proving the inflation is the floor and not a general ABO markup.
  const total = await totalDailySpendCents("ABO", 2000 * 100, 4);
  assert.strictEqual(total, 2000 * 100);
});
