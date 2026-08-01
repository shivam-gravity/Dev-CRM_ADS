import { test } from "node:test";
import assert from "node:assert";

delete process.env.META_ACCESS_TOKEN;
delete process.env.META_AD_ACCOUNT_ID;

const { metaAdapter, MetaGraphError } = await import("../modules/adapters/metaAdapter.js");

const CREDS = { accessToken: "tok", adAccountId: "act_1", currency: "INR", pageId: "page_1" } as const;

async function captureAdSet(input: Record<string, unknown>) {
  const original = global.fetch;
  let body: any = {};
  global.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/adsets")) body = init?.body ? JSON.parse(String(init.body)) : {};
    return { ok: true, json: async () => ({ id: "obj_1" }) } as Response;
  }) as typeof fetch;
  try {
    await metaAdapter.createAdSetContainer!(
      { campaignExternalId: "camp_1", name: "AS", dailyBudgetCents: 50000, targeting: {}, ...input } as any,
      CREDS as any
    );
    return body;
  } finally {
    global.fetch = original;
  }
}

/** The builder's two Delivery checkboxes have to reach Meta, and an unticked box has to stay
 *  unticked — a control the system silently overrides is worse than no control. */

test("Advantage+ ticked reaches Meta as targeting_automation", async () => {
  const body = await captureAdSet({ advantagePlus: true });
  assert.deepStrictEqual(body.targeting_automation, { advantage_audience: 1 });
});

test("Advantage+ unticked sends nothing", async () => {
  const body = await captureAdSet({ advantagePlus: false });
  assert.strictEqual(body.targeting_automation, undefined);
});

test("CBO ticked moves the budget to the campaign and strips it from the ad set", async () => {
  const original = global.fetch;
  const bodies: Record<string, any> = {};
  global.fetch = (async (url: string, init?: RequestInit) => {
    const b = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(url).includes("/adsets")) bodies.adset = b;
    else if (String(url).includes("/campaigns")) bodies.campaign = b;
    return { ok: true, json: async () => ({ id: "obj_1" }) } as Response;
  }) as typeof fetch;
  try {
    await metaAdapter.createCampaignContainer!(
      { name: "C", objective: "OUTCOME_SALES", budgetMode: "CBO", dailyBudgetCents: 50000 },
      CREDS as any
    );
    await metaAdapter.createAdSetContainer!(
      { campaignExternalId: "camp_1", name: "AS", dailyBudgetCents: 50000, budgetMode: "CBO", targeting: {} },
      CREDS as any
    );
  } finally {
    global.fetch = original;
  }
  assert.strictEqual(bodies.campaign.is_adset_budget_sharing_enabled, true, "this flag IS Campaign Budget Optimization");
  assert.ok(bodies.campaign.daily_budget > 0);
  assert.strictEqual(bodies.adset.daily_budget, undefined, "a CBO ad set carrying its own budget is rejected by Meta");
  assert.strictEqual(bodies.adset.bid_strategy, undefined);
});

test("ABO leaves budget sharing off", async () => {
  const original = global.fetch;
  let campaign: any = {};
  global.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/campaigns")) campaign = init?.body ? JSON.parse(String(init.body)) : {};
    return { ok: true, json: async () => ({ id: "c" }) } as Response;
  }) as typeof fetch;
  try {
    await metaAdapter.createCampaignContainer!(
      { name: "C", objective: "OUTCOME_SALES", budgetMode: "ABO", dailyBudgetCents: 50000 },
      CREDS as any
    );
  } finally {
    global.fetch = original;
  }
  // Meta requires the flag to be explicit either way (subcode 4834011 when omitted).
  assert.strictEqual(campaign.is_adset_budget_sharing_enabled, false);
  assert.strictEqual(campaign.daily_budget, undefined);
});

/** Funding failures are the one publish error the platform cannot fix for the user. They have to be
 *  distinguishable from a misconfiguration, or "publishing failed" is all anyone ever learns. */

async function errorFor(body: unknown, status = 400): Promise<InstanceType<typeof MetaGraphError>> {
  const original = global.fetch;
  global.fetch = (async () =>
    ({ ok: false, status, text: async () => JSON.stringify(body) }) as unknown as Response) as typeof fetch;
  try {
    await metaAdapter.createCampaignContainer!({ name: "C", objective: "OUTCOME_SALES" }, CREDS as any);
    throw new Error("expected a rejection");
  } catch (err) {
    return err as InstanceType<typeof MetaGraphError>;
  } finally {
    global.fetch = original;
  }
}

test("insufficient funds is classified as a payment problem", async () => {
  const err = await errorFor({ error: { code: 1359188, message: "Ad Account Has Insufficient Funds" } });
  assert.ok(err instanceof MetaGraphError);
  assert.strictEqual(err.isPaymentError, true);
  assert.strictEqual(err.isAuthError, false);
});

test("billing text with no numeric code is still caught", async () => {
  // Meta does not always attach a code to billing rejections, so the end-user text is the only
  // reliable signal for some of them.
  const err = await errorFor({
    error: { message: "Bad request", error_user_title: "Payment method needed", error_user_msg: "Add a payment method to continue." },
  });
  assert.strictEqual(err.isPaymentError, true);
});

test("a spend-cap rejection reads as payment, not as a bad request", async () => {
  const err = await errorFor({ error: { message: "You have exceeded your spending limit." } });
  assert.strictEqual(err.isPaymentError, true);
});

test("ordinary failures are NOT mislabelled as payment problems", async () => {
  // Over-eager matching would send users to a billing page over a budget or naming mistake.
  for (const message of ["Budget is too low", "Name is too long", "Invalid objective", "Conversion event unavailable"]) {
    const err = await errorFor({ error: { message } });
    assert.strictEqual(err.isPaymentError, false, message);
  }
});

test("an expired token stays an auth error, not a payment one", async () => {
  const err = await errorFor({ error: { code: 190, type: "OAuthException", message: "Session has expired" } }, 401);
  assert.strictEqual(err.isAuthError, true);
  assert.strictEqual(err.isPaymentError, false);
});
