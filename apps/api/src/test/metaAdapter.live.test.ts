import { test } from "node:test";
import assert from "node:assert";

// Live-credential paths are gated by env vars read at module load time, so they
// must be set before the adapter module is imported — hence the dynamic import
// and a dedicated test file, isolated from metaAdapter.test.ts's mock-path run.
process.env.META_ACCESS_TOKEN = "test-access-token";
process.env.META_AD_ACCOUNT_ID = "9876543210";

const { metaAdapter, MetaGraphError } = await import("../modules/adapters/metaAdapter.js");

function withMockFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = global.fetch;
  global.fetch = impl;
  return run().finally(() => {
    global.fetch = original;
  });
}

test("Meta Ads Adapter (live) - launchVariant calls the Graph API and returns the ad id", async () => {
  await withMockFetch(
    (async (url: string) => {
      assert.ok(String(url).includes("act_9876543210/ads"));
      assert.ok(String(url).includes("test-access-token"));
      return { ok: true, json: async () => ({ id: "meta_123456" }) } as Response;
    }) as typeof fetch,
    async () => {
      const result = await metaAdapter.launchVariant({
        campaignId: "camp-1",
        variantId: "var-1",
        creative: { headline: "Headline", body: "Body", callToAction: "Learn More" },
        dailyBudgetCents: 5000,
      });
      assert.strictEqual(result.externalId, "meta_123456");
      // PAUSED, not active. b6fe4a6 ("launchVariant publishing ACTIVE") made every ad-creating call
      // in this adapter land paused so going live is an explicit, separate step that cannot happen
      // by accident. This assertion was left behind asserting the behaviour that fix removed.
      assert.strictEqual(result.status, "paused");
    }
  );
});

test("Meta Ads Adapter (live) - launchVariant throws after exhausting retries on repeated failure", async () => {
  let calls = 0;
  await withMockFetch(
    (async () => {
      calls++;
      return { ok: false, status: 500, text: async () => "server error" } as Response;
    }) as typeof fetch,
    async () => {
      await assert.rejects(() =>
        metaAdapter.launchVariant({
          campaignId: "camp-1",
          variantId: "var-1",
          creative: { headline: "Headline", body: "Body", callToAction: "Learn More" },
          dailyBudgetCents: 5000,
        })
      );
      assert.strictEqual(calls, 3, "should attempt the request 3 times before giving up");
    }
  );
});

test("Meta Ads Adapter (live) - a non-retryable 400 fails FAST (one attempt) with a classified MetaGraphError", async () => {
  let calls = 0;
  await withMockFetch(
    (async () => {
      calls++;
      // A "name is too long" style hard client error — retrying it is pointless.
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          error: { message: "Invalid parameter", code: 100, error_subcode: 2446443, error_user_title: "Name Too Long", error_user_msg: "The name you entered is too long.", type: "OAuthException", fbtrace_id: "abc123" },
        }),
      } as unknown as Response;
    }) as typeof fetch,
    async () => {
      const err = await metaAdapter.createCampaignContainer!(
        { name: "x".repeat(500), objective: "OUTCOME_TRAFFIC" },
        { accessToken: "t", adAccountId: "9876543210", currency: "USD" },
      ).then(() => null, (e) => e);
      assert.ok(err instanceof MetaGraphError, "should throw a classified MetaGraphError");
      assert.strictEqual(err.httpStatus, 400);
      assert.strictEqual(err.code, 100);
      assert.strictEqual(err.subcode, 2446443);
      assert.strictEqual(err.userMessage, "Name Too Long: The name you entered is too long.");
      assert.strictEqual(calls, 1, "a non-retryable 4xx must NOT be retried");
    }
  );
});

test("Meta Ads Adapter (live) - an auth error (code 190) is classified isAuthError and not retried", async () => {
  let calls = 0;
  await withMockFetch(
    (async () => {
      calls++;
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        text: async () => JSON.stringify({ error: { message: "Invalid OAuth access token", code: 190, type: "OAuthException", fbtrace_id: "z" } }),
      } as unknown as Response;
    }) as typeof fetch,
    async () => {
      const err = await metaAdapter.createCampaignContainer!(
        { name: "ok", objective: "OUTCOME_TRAFFIC" },
        { accessToken: "dead", adAccountId: "9876543210", currency: "USD" },
      ).then(() => null, (e) => e);
      assert.ok(err instanceof MetaGraphError);
      assert.strictEqual(err.isAuthError, true, "code 190 must classify as an auth error so the orchestrator can refresh");
      assert.strictEqual(err.isRateLimit, false);
      assert.strictEqual(calls, 1, "an auth error is non-retryable at the HTTP level");
    }
  );
});

test("Meta Ads Adapter (live) - a rate-limit error (code 17) IS retried and honors Retry-After", async () => {
  let calls = 0;
  await withMockFetch(
    (async () => {
      calls++;
      // Succeed on the 2nd attempt to prove the rate-limited 1st was retried (not failed-fast).
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? "0" : null) },
          text: async () => JSON.stringify({ error: { message: "User request limit reached", code: 17 } }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({ id: "meta_camp_1" }) } as Response;
    }) as typeof fetch,
    async () => {
      const result = await metaAdapter.createCampaignContainer!(
        { name: "ok", objective: "OUTCOME_TRAFFIC" },
        { accessToken: "t", adAccountId: "9876543210", currency: "USD" },
      );
      assert.strictEqual(result.externalId, "meta_camp_1");
      assert.strictEqual(calls, 2, "a rate-limit response must be retried (not failed fast)");
    }
  );
});

test("Meta Ads Adapter (live) - createHierarchyAd builds creative + ad and returns PAUSED", async () => {
  const posted: string[] = [];
  await withMockFetch(
    (async (url: string) => {
      posted.push(String(url).split("?")[0]);
      const id = String(url).includes("adcreatives") ? "creative_1" : "ad_1";
      return { ok: true, json: async () => ({ id }) } as Response;
    }) as typeof fetch,
    async () => {
      const result = await metaAdapter.createHierarchyAd!(
        {
          adSetExternalId: "adset_1",
          name: "camp-1-var-1",
          creative: { headline: "H", body: "B", callToAction: "Learn More" },
          landingPageUrl: "https://opentalent.in",
          imageHash: "hash_1",
        },
        { accessToken: "t", adAccountId: "9876543210", currency: "USD", pageId: "111" },
      );
      // Hierarchy ads land PAUSED — the whole point of the safe-by-default publish path.
      assert.strictEqual(result.status, "paused");
      assert.strictEqual(result.externalId, "ad_1");
      assert.ok(posted.some((u) => u.includes("adcreatives")), "should create an ad creative first");
      assert.ok(posted.some((u) => u.endsWith("/ads")), "then create the ad");
    }
  );
});

test("Meta Ads Adapter (live) - fetchInsights parses metrics from the insights endpoint", async () => {
  await withMockFetch(
    (async (url: string) => {
      assert.ok(String(url).includes("/insights"));
      // fields= includes "reach" (see metaAdapter.ts's fetchInsights URL) — the mocked
      // response must include it too, or the parsed result legitimately (and correctly)
      // defaults it to 0, which used to look like a bug here rather than a stale fixture.
      return {
        ok: true,
        json: async () => ({
          data: [{
            impressions: "2000", reach: "1500", clicks: "80", spend: "40.00",
            // Each funnel step is its own action_type row alongside the conversion count.
            actions: [
              { action_type: "offsite_conversion", value: "6" },
              { action_type: "add_to_cart", value: "20" },
              { action_type: "add_payment_info", value: "9" },
              { action_type: "purchase", value: "6" },
            ],
            // action_values carries the real purchase VALUE parallel to actions' count.
            action_values: [{ action_type: "offsite_conversion", value: "150.00" }],
          }],
        }),
      } as Response;
    }) as typeof fetch,
    async () => {
      const stats = await metaAdapter.fetchInsights("meta_123456", "2026-07-06");
      // revenueCents = action_values offsite_conversion (150.00) * 100 → true ROAS input.
      // funnel breaks out per-step counts (add_to_cart/add_payment_info/purchase) from `actions`.
      assert.deepStrictEqual(stats, {
        impressions: 2000, reach: 1500, clicks: 80, conversions: 6, spendCents: 4000, revenueCents: 15000,
        funnel: { addToCart: 20, addPaymentInfo: 9, purchases: 6, purchaseValueCents: 15000 },
      });
    }
  );
});
