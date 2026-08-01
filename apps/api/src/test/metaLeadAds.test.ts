import { test } from "node:test";
import assert from "node:assert";

// Same reason as metaAdapter.test.ts: cleared before the first import so live credentials leaking
// from another test file's dotenv side effect cannot flip this file out of its assumptions.
delete process.env.META_ACCESS_TOKEN;
delete process.env.META_AD_ACCOUNT_ID;

const { metaAdapter } = await import("../modules/adapters/metaAdapter.js");

const CREDS = { accessToken: "tok", adAccountId: "act_1", currency: "INR", pageId: "page_1" } as const;
const CREATIVE = { headline: "Book a demo", body: "See it in action.", callToAction: "Learn More" };

/** Captures the Graph bodies for one ad-set + one ad creation. */
async function capture(run: () => Promise<unknown>) {
  const original = global.fetch;
  const bodies: Record<string, any> = {};
  global.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const u = String(url);
    if (u.includes("/adsets")) bodies.adset = body;
    else if (u.includes("/adcreatives")) bodies.creative = body;
    else if (u.includes("/ads")) bodies.ad = body;
    return { ok: true, json: async () => ({ id: "obj_1" }) } as Response;
  }) as typeof fetch;
  try {
    await run();
    return bodies;
  } finally {
    global.fetch = original;
  }
}

// An instant form is what makes a small budget viable: the lead is collected inside Facebook, so
// there is no landing page to convert and no pixel volume to accumulate. Meta is strict that the
// three pieces agree — goal, destination and promoted object — and rejects any mismatch.
test("Lead Ads - ad set optimises for LEAD_GENERATION against the PAGE, not a pixel", async () => {
  const bodies = await capture(() =>
    metaAdapter.createAdSetContainer!(
      {
        campaignExternalId: "camp_1",
        name: "AS",
        dailyBudgetCents: 10000,
        budgetMode: "CBO",
        objective: "OUTCOME_LEADS",
        targeting: {},
        leadGenFormId: "form_123",
        pageId: "page_1",
        // A pixel is deliberately supplied to prove the lead-form path IGNORES it.
        promotedObject: { pixelId: "px_1", customEventType: "LEAD" },
      },
      CREDS as any
    )
  );

  assert.strictEqual(bodies.adset.optimization_goal, "LEAD_GENERATION");
  assert.strictEqual(bodies.adset.destination_type, "ON_AD", "the lead is collected on Meta, not the site");
  assert.deepStrictEqual(bodies.adset.promoted_object, { page_id: "page_1" });
  assert.strictEqual(
    bodies.adset.promoted_object.pixel_id,
    undefined,
    "a pixel promoted_object on a LEAD_GENERATION ad set is rejected by Meta"
  );
});

test("Lead Ads - the creative CTA opens the form instead of the landing page", async () => {
  const bodies = await capture(() =>
    metaAdapter.createHierarchyAd!(
      {
        adSetExternalId: "as_1",
        name: "Ad",
        creative: CREATIVE,
        landingPageUrl: "https://polluxa.com/",
        leadGenFormId: "form_123",
      },
      CREDS as any
    )
  );

  const cta = bodies.creative.object_story_spec.link_data.call_to_action;
  assert.strictEqual(cta.value.lead_gen_form_id, "form_123");
  // Meta requires a lead-intent CTA on a lead form; the creative's own free-text "Learn More" would
  // otherwise map to LEARN_MORE and be rejected.
  assert.strictEqual(cta.type, "SIGN_UP");
});

test("without a form the ad set and creative keep the website-conversion shape", async () => {
  const adSet = await capture(() =>
    metaAdapter.createAdSetContainer!(
      {
        campaignExternalId: "camp_1",
        name: "AS",
        dailyBudgetCents: 10000,
        budgetMode: "CBO",
        objective: "OUTCOME_LEADS",
        targeting: {},
        optimizationGoal: "OFFSITE_CONVERSIONS",
        promotedObject: { pixelId: "px_1", customEventType: "LEAD" },
      },
      CREDS as any
    )
  );
  assert.strictEqual(adSet.adset.optimization_goal, "OFFSITE_CONVERSIONS");
  assert.strictEqual(adSet.adset.destination_type, undefined);
  assert.deepStrictEqual(adSet.adset.promoted_object, { pixel_id: "px_1", custom_event_type: "LEAD" });

  const ad = await capture(() =>
    metaAdapter.createHierarchyAd!(
      { adSetExternalId: "as_1", name: "Ad", creative: CREATIVE, landingPageUrl: "https://polluxa.com/" },
      CREDS as any
    )
  );
  const cta = ad.creative.object_story_spec.link_data.call_to_action;
  assert.strictEqual(cta.value.lead_gen_form_id, undefined);
  assert.strictEqual(cta.value.link, "https://polluxa.com/");
});

// The event ladder steps a small budget DOWN to a reachable goal. A pixel promoted_object pairs a
// conversion target with a non-conversion goal, which Meta rejects — and is pointless anyway, since
// nothing is optimising for that conversion.
test("a stepped-down goal drops the pixel promoted_object", async () => {
  const bodies = await capture(() =>
    metaAdapter.createAdSetContainer!(
      {
        campaignExternalId: "camp_1",
        name: "AS",
        dailyBudgetCents: 10000,
        budgetMode: "CBO",
        objective: "OUTCOME_LEADS",
        targeting: {},
        optimizationGoal: "LANDING_PAGE_VIEWS",
        promotedObject: { pixelId: "px_1", customEventType: "LEAD" },
      },
      CREDS as any
    )
  );
  assert.strictEqual(bodies.adset.optimization_goal, "LANDING_PAGE_VIEWS");
  assert.strictEqual(bodies.adset.promoted_object, undefined);
});

test("an explicit optimizationGoal overrides the objective-derived default", async () => {
  const bodies = await capture(() =>
    metaAdapter.createAdSetContainer!(
      {
        campaignExternalId: "camp_1",
        name: "AS",
        dailyBudgetCents: 10000,
        budgetMode: "CBO",
        objective: "OUTCOME_SALES",
        targeting: {},
        optimizationGoal: "LINK_CLICKS",
      },
      CREDS as any
    )
  );
  assert.strictEqual(bodies.adset.optimization_goal, "LINK_CLICKS");
});
