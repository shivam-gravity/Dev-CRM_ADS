import { test } from "node:test";
import assert from "node:assert";

process.env.TOKEN_ENCRYPTION_KEY = "0".repeat(64);
process.env.JWT_SECRET = "test-jwt-secret";

test("Meta OAuth - startMetaConnect mock-connects when no Meta App is registered (dev convenience)", async () => {
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  const { startMetaConnect } = await import(`../modules/integrations/metaOAuth.js?t=${Date.now()}`);
  const result = await startMetaConnect("workspace-1");
  assert.deepStrictEqual(result, { mockConnected: true });
});

// The mock connection writes realistic-looking names ("Polluxa Ads (mock)") with status
// "connected", so in a DEPLOYED environment it presents an account that cannot publish anything as
// though it were live — indistinguishable from the real thing at a glance. Production must refuse.
test("Meta OAuth - startMetaConnect REFUSES in production instead of fabricating a connection", async () => {
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const { startMetaConnect } = await import(`../modules/integrations/metaOAuth.js?t=${Date.now()}`);
    const { OAuthNotConfiguredError } = await import("../modules/integrations/oauthErrors.js");
    await assert.rejects(
      () => startMetaConnect("workspace-prod-refusal"),
      (err: unknown) => err instanceof OAuthNotConfiguredError && /not configured/i.test((err as Error).message),
      "must throw OAuthNotConfiguredError (a permanent condition) rather than write a fake connection"
    );
  } finally {
    process.env.NODE_ENV = previousEnv;
  }
});

test("Meta OAuth - getMetaAuthUrl builds a signed-state Facebook dialog URL when credentials are set", async () => {
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  const { getMetaAuthUrl } = await import(`../modules/integrations/metaOAuth.js?t=${Date.now()}`);
  const url = getMetaAuthUrl("workspace-1");
  assert.ok(url.startsWith("https://www.facebook.com/v22.0/dialog/oauth?"));
  const params = new URL(url).searchParams;
  assert.strictEqual(params.get("client_id"), "test-app-id");
  assert.ok(params.get("state"), "state param should be present");
  assert.ok(params.get("scope")?.includes("ads_management"));
});

test("Meta OAuth - handleMetaOAuthCallback rejects a tampered/expired state", async () => {
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  const { handleMetaOAuthCallback } = await import(`../modules/integrations/metaOAuth.js?t=${Date.now()}`);
  await assert.rejects(() => handleMetaOAuthCallback("some-code", "not-a-valid-jwt"));
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("Meta OAuth - validateMetaManualCredentials proves the ad account, normalizes the id, and returns real names", async () => {
  const { validateMetaManualCredentials } = await import(`../modules/integrations/metaOAuth.js?t=${Date.now()}`);
  const original = global.fetch;
  const calls: string[] = [];
  global.fetch = (async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/act_123")) return jsonResponse({ name: "Acme Ads", currency: "INR", account_status: 1 });
    if (u.includes("/page-9")) return jsonResponse({ name: "Acme Page" });
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
  try {
    const result = await validateMetaManualCredentials({
      accessToken: "user-token",
      adAccountId: "123", // deliberately WITHOUT the act_ prefix
      pageId: "page-9",
      pageAccessToken: "page-token",
    });
    assert.strictEqual(result.adAccountId, "act_123", "bare digits from the Ads Manager URL must be normalized, not rejected");
    assert.strictEqual(result.name, "Acme Ads", "the real account name replaces the 'Ad Account act_123' placeholder");
    assert.strictEqual(result.pageName, "Acme Page");
    // The page token is the credential lead capture actually uses, so it's the one that must be proven.
    assert.ok(
      calls.some((u) => u.includes("page-9") && u.includes("access_token=page-token")),
      "the page probe must use the PAGE token, not the user token"
    );
  } finally {
    global.fetch = original;
  }
});

// Both token fields are masked and adjacent, so an error naming only a Graph path leaves the user
// unable to tell WHICH field was wrong. That ambiguity is what turned a field mix-up into a long
// hunt for a "broken" credential, so the field name is asserted here rather than left to chance.
test("Meta OAuth - a page-probe failure blames the PAGE token and says it can be left empty", async () => {
  const { validateMetaManualCredentials } = await import(`../modules/integrations/metaOAuth.js?t=${Date.now()}`);
  const original = global.fetch;
  global.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("/act_1")) return jsonResponse({ name: "Acme Ads", currency: "INR", account_status: 1 });
    // The page probe fails — the ad account already succeeded, so this is unambiguously the page token.
    if (u.includes("/page-9")) return jsonResponse({ error: { message: "Invalid OAuth access token." } }, 400);
    if (u.includes("debug_token")) return jsonResponse({ data: { is_valid: false, type: "PAGE" } });
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => validateMetaManualCredentials({ accessToken: "good", adAccountId: "act_1", pageId: "page-9", pageAccessToken: "stale" }),
      (err: unknown) => {
        const m = (err as Error).message;
        assert.match(m, /Page Access Token was rejected/, "must name the PAGE token, not just the numeric page path");
        assert.match(m, /Leave "Page Access Token" empty/, "must offer the fix that actually unblocks this");
        return true;
      }
    );
  } finally {
    global.fetch = original;
  }
});

test("Meta OAuth - an ad-account failure blames the ACCESS token", async () => {
  const { validateMetaManualCredentials } = await import(`../modules/integrations/metaOAuth.js?t=${Date.now()}`);
  const original = global.fetch;
  global.fetch = (async (url: unknown) => {
    if (String(url).includes("debug_token")) return jsonResponse({ data: { is_valid: false, type: "USER" } });
    return jsonResponse({ error: { message: "The token has expired on Friday, 05-Jun-26." } }, 400);
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => validateMetaManualCredentials({ accessToken: "expired", adAccountId: "act_1" }),
      /Access Token was rejected for ad account act_1/
    );
  } finally {
    global.fetch = original;
  }
});

test("Meta OAuth - validateMetaManualCredentials surfaces Meta's user-facing message so a bad token is actionable", async () => {
  const { validateMetaManualCredentials } = await import(`../modules/integrations/metaOAuth.js?t=${Date.now()}`);
  const original = global.fetch;
  global.fetch = (async () =>
    jsonResponse({ error: { message: "Invalid OAuth access token.", error_user_msg: "Your access token has expired. Generate a new one." } }, 400)) as typeof fetch;
  try {
    // error_user_msg must win over the developer-facing `message` — that's the text the user sees.
    await assert.rejects(
      () => validateMetaManualCredentials({ accessToken: "expired", adAccountId: "act_1" }),
      /Your access token has expired/,
      "validation must reject rather than let setMetaManualConnection store an unusable token as 'connected'"
    );
  } finally {
    global.fetch = original;
  }
});
