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
    // The ACCESS token here is a valid USER token — this scenario is specifically "good access
    // token, stale PAGE token". Leaving this as type:"PAGE" would now trip the page-token guard
    // first and short-circuit the page-probe path this test exists to cover.
    if (u.includes("debug_token")) return jsonResponse({ data: { is_valid: true, type: "USER" } });
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

test("Meta OAuth - a PAGE access token is refused at connect time, not left to fail at publish", async () => {
  const { validateMetaManualCredentials } = await import(`../modules/integrations/metaOAuth.js?t=${Date.now()}`);
  // A Page token reads the ad account fine and can create campaigns/ad sets/creatives, so every
  // connect-time probe passed and the integration looked healthy — then POST /act_X/ads failed with
  // Meta's `code 3 "Unknown method"` plus an unrelated "Certification required" message, sending the
  // operator to a policy page instead of to the credential. Verified live: such a token returns the
  // PAGE as /me and 400s on /me/adaccounts.
  const original = global.fetch;
  global.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("debug_token")) return jsonResponse({ data: { is_valid: true, type: "PAGE" } });
    if (u.includes("/act_1")) return jsonResponse({ name: "Acme Ads", currency: "INR", account_status: 1 });
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => validateMetaManualCredentials({ accessToken: "a-page-token", adAccountId: "act_1" }),
      (err: unknown) => {
        const m = (err as Error).message;
        assert.match(m, /PAGE token/, "must name the token TYPE as the problem");
        assert.match(m, /User \(or System User\)/, "must say which token type is actually required");
        return true;
      }
    );
  } finally {
    global.fetch = original;
  }
});

// Graph API Explorer hands out ~1-2 hour User tokens. On a deployment with no META_APP_ID/SECRET
// there is no refresh path at all, so such a token connects cleanly and then dies within the hour —
// the same "healthy at connect, broken at publish" shape as the PAGE token, and the reason a first
// reconnect attempt here failed with an already-expired token.
test("Meta OAuth - a soon-to-expire token is refused when the deployment cannot refresh it", async () => {
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  const { validateMetaManualCredentials } = await import(`../modules/integrations/metaOAuth.js?t=${Date.now()}`);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600; // one hour from now
  const original = global.fetch;
  global.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("debug_token"))
      return jsonResponse({ data: { is_valid: true, type: "USER", scopes: ["ads_management"], expires_at: expiresAt } });
    if (u.includes("/act_1")) return jsonResponse({ name: "Acme Ads", currency: "INR", account_status: 1 });
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => validateMetaManualCredentials({ accessToken: "short-lived", adAccountId: "act_1" }),
      (err: unknown) => {
        const m = (err as Error).message;
        assert.match(m, /expires in/i, "must say the token is about to expire");
        assert.match(m, /cannot be refreshed automatically/i, "must explain WHY that is fatal here");
        assert.match(m, /System User/i, "must point at the durable fix");
        return true;
      }
    );
  } finally {
    global.fetch = original;
  }
});

// The refusal above is about the missing refresh path, NOT about short-lived tokens being bad in
// principle — with app credentials present the token is recoverable and rejecting it would be wrong.
test("Meta OAuth - the same short-lived token is ACCEPTED when refresh credentials exist", async () => {
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  const { validateMetaManualCredentials } = await import(`../modules/integrations/metaOAuth.js?t=${Date.now()}`);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const original = global.fetch;
  global.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("debug_token"))
      return jsonResponse({ data: { is_valid: true, type: "USER", scopes: ["ads_management"], expires_at: expiresAt } });
    if (u.includes("/act_1")) return jsonResponse({ name: "Acme Ads", currency: "INR", account_status: 1 });
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
  try {
    const result = await validateMetaManualCredentials({ accessToken: "short-lived", adAccountId: "act_1" });
    assert.strictEqual(result.adAccountId, "act_1");
  } finally {
    global.fetch = original;
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
  }
});

// ads_read alone passes every connect-time READ, so the connection looks perfect and only writes fail.
test("Meta OAuth - a token without ads_management is refused even though reads succeed", async () => {
  const { validateMetaManualCredentials } = await import(`../modules/integrations/metaOAuth.js?t=${Date.now()}`);
  const original = global.fetch;
  global.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("debug_token"))
      return jsonResponse({ data: { is_valid: true, type: "USER", scopes: ["ads_read", "public_profile"], expires_at: 0 } });
    if (u.includes("/act_1")) return jsonResponse({ name: "Acme Ads", currency: "INR", account_status: 1 });
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => validateMetaManualCredentials({ accessToken: "read-only", adAccountId: "act_1" }),
      (err: unknown) => {
        const m = (err as Error).message;
        assert.match(m, /ads_management/, "must name the missing permission");
        assert.match(m, /ads_read/, "must list what the token DOES have, so the gap is obvious");
        return true;
      }
    );
  } finally {
    global.fetch = original;
  }
});

// An already-expired token cannot be classified by debug_token (it authenticates with the token
// under inspection), so it lands in the ad-account probe. Meta states the expiry date but not the
// remedy, and "just generate another one" is the wrong lesson where refresh is impossible.
test("Meta OAuth - an expired token's rejection carries the durable-token advice", async () => {
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  const { validateMetaManualCredentials } = await import(`../modules/integrations/metaOAuth.js?t=${Date.now()}`);
  const original = global.fetch;
  global.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("debug_token")) return jsonResponse({ error: { message: "Error validating access token" } }, 400);
    if (u.includes("/act_1"))
      return jsonResponse({ error: { message: "The token has expired on Friday, 05-Jun-26 05:31:24 PDT." } }, 400);
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => validateMetaManualCredentials({ accessToken: "expired", adAccountId: "act_1" }),
      (err: unknown) => {
        const m = (err as Error).message;
        assert.match(m, /has expired/, "must keep Meta's own expiry detail");
        assert.match(m, /System User/i, "must add the remedy Meta omits");
        assert.match(m, /Never/, "must say the expiration setting to choose");
        return true;
      }
    );
  } finally {
    global.fetch = original;
  }
});

test("Meta OAuth - an unreachable debug_token does NOT block a connection", async () => {
  const { validateMetaManualCredentials } = await import(`../modules/integrations/metaOAuth.js?t=${Date.now()}`);
  // Classification is best-effort: refusing a possibly-good credential over a transient Graph
  // failure is worse than letting it through, since the scheduled health check re-examines it.
  const original = global.fetch;
  global.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("debug_token")) throw new TypeError("fetch failed");
    if (u.includes("/act_1")) return jsonResponse({ name: "Acme Ads", currency: "INR", account_status: 1 });
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
  try {
    const result = await validateMetaManualCredentials({ accessToken: "unknown-type", adAccountId: "act_1" });
    assert.strictEqual(result.adAccountId, "act_1");
    assert.strictEqual(result.currency, "INR");
  } finally {
    global.fetch = original;
  }
});
