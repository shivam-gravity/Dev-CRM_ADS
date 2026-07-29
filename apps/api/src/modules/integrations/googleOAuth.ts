import { logger } from "../logger/logger.js";
import {
  setGoogleOAuthConnection,
  getRawGoogleTokenData,
  updateGoogleAccessToken,
} from "./integrationService.js";
import { signOAuthState, verifyOAuthState } from "./oauthState.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ADS_API_VERSION = "v24";

const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "http://localhost:4000/api/integrations/google/oauth/callback";
const GOOGLE_ADS_DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;

// A developer token is also required to actually call the Ads API (not just OAuth), unlike
// Meta where the App credentials alone are enough to complete the handshake.
export const hasLiveGoogleAppCredentials = Boolean(GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET && GOOGLE_ADS_DEVELOPER_TOKEN);

// Refresh proactively this far ahead of actual expiry to avoid a request racing the clock.
const REFRESH_SKEW_MS = 2 * 60 * 1000;

export function getGoogleAuthUrl(workspaceId: string): string {
  const state = signOAuthState(workspaceId);
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID ?? "",
    redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/adwords",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Realistic-shaped mock connection (a plausible 10-digit customer ID, not a random
// "act_..." string) so the Advertising Accounts page's "Customer" row looks right even
// in local/demo mode with no real Google OAuth client registered.
async function mockConnectGoogle(workspaceId: string): Promise<void> {
  await setGoogleOAuthConnection(workspaceId, {
    refreshToken: "mock-refresh-token",
    accessToken: "mock-access-token",
    expiresInSeconds: 60 * 60 * 24 * 60,
    customerId: "1234567890",
    customerName: "Polluxa Google Ads MCC (mock)",
    mock: true,
  });
}

/**
 * Entry point for the "Connect" button. Same shape as metaOAuth.startMetaConnect: with no
 * Google OAuth client (or no developer token) registered, there's nothing real to redirect
 * to, so this mock-connects immediately instead of sending the user to a broken consent screen.
 */
export async function startGoogleConnect(workspaceId: string): Promise<{ redirectUrl: string } | { mockConnected: true }> {
  if (!hasLiveGoogleAppCredentials) {
    logger.warn("Google OAuth client/developer token not set — mock-connecting Google instead of redirecting");
    await mockConnectGoogle(workspaceId);
    return { mockConnected: true };
  }
  return { redirectUrl: getGoogleAuthUrl(workspaceId) };
}

async function exchangeCodeForTokens(code: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_OAUTH_CLIENT_ID ?? "",
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const json = (await res.json()) as any;
  if (!res.ok || !json.access_token) throw new Error(`Google token exchange failed: ${json.error_description ?? res.status}`);
  if (!json.refresh_token) {
    throw new Error("Google did not return a refresh token — remove Polluxa's access at myaccount.google.com/permissions and reconnect (offline access is only granted on first consent)");
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in ?? 3600 };
}

/** clientId/clientSecret default to the global OAuth app's credentials, but a manually-connected integration can supply its own (see setGoogleManualConnection) — those take precedence since the refresh token was issued against that client, not necessarily Polluxa's registered app. */
async function refreshAccessToken(refreshToken: string, clientId?: string, clientSecret?: string): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId ?? GOOGLE_OAUTH_CLIENT_ID ?? "",
      client_secret: clientSecret ?? GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
    }),
  });
  const json = (await res.json()) as any;
  if (!res.ok || !json.access_token) throw new Error(`Google token refresh failed: ${json.error_description ?? res.status}`);
  return { accessToken: json.access_token, expiresIn: json.expires_in ?? 3600 };
}

async function fetchFirstAccessibleCustomer(accessToken: string): Promise<string | null> {
  const res = await fetch(`https://googleads.googleapis.com/${ADS_API_VERSION}/customers:listAccessibleCustomers`, {
    headers: { Authorization: `Bearer ${accessToken}`, "developer-token": GOOGLE_ADS_DEVELOPER_TOKEN ?? "" },
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`Failed to list accessible Google Ads customers: ${JSON.stringify(json)}`);
  const resourceName = (json.resourceNames ?? [])[0] as string | undefined;
  return resourceName ? resourceName.replace("customers/", "") : null;
}

/**
 * Proves manually-pasted Google Ads credentials work BEFORE they are persisted — the counterpart to
 * validateMetaManualCredentials, and for the same reason: setGoogleManualConnection otherwise stores
 * whatever it's given and reports "connected", so a wrong developer token or an expired access token
 * only shows up much later as a publish failure far from its cause.
 *
 * listAccessibleCustomers is the right probe because it exercises BOTH credentials at once (the
 * OAuth access token in Authorization, the developer token in its own header) and returns the set of
 * customers this token may actually touch. Checking the supplied customerId against that set catches
 * the most common real mistake: valid credentials pointed at a customer the login can't access.
 *
 * Customer IDs are compared as bare digits since Google shows them dashed (123-456-7890) but the API
 * returns them undashed — comparing raw strings would reject correct input.
 */
export async function validateGoogleManualCredentials(input: {
  customerId: string;
  developerToken: string;
  accessToken: string;
}): Promise<{ customerId: string; accessibleCustomerIds: string[] }> {
  const res = await fetch(`https://googleads.googleapis.com/${ADS_API_VERSION}/customers:listAccessibleCustomers`, {
    headers: { Authorization: `Bearer ${input.accessToken}`, "developer-token": input.developerToken },
  });
  const json = (await res.json()) as any;
  if (!res.ok) {
    // Google nests the useful text under error.message; fall back to the status when it's absent.
    throw new Error(`Google Ads rejected these credentials: ${json?.error?.message ?? `HTTP ${res.status}`}`);
  }

  const digits = (v: string) => v.replace(/\D/g, "");
  const accessibleCustomerIds = ((json.resourceNames ?? []) as string[]).map((r) => digits(r.replace("customers/", "")));
  const wanted = digits(input.customerId);

  if (accessibleCustomerIds.length > 0 && !accessibleCustomerIds.includes(wanted)) {
    throw new Error(
      `These credentials are valid but cannot access customer ${input.customerId}. Accessible: ${accessibleCustomerIds.join(", ") || "none"}.`
    );
  }
  return { customerId: wanted, accessibleCustomerIds };
}

/**
 * Completes the OAuth handshake: code -> access+refresh token, then picks the first
 * accessible Google Ads customer account (multi-account picker is a follow-up, same as
 * Meta's ad-account selection). Falls back to mock connect when no OAuth client is
 * registered, so local dev keeps working without real credentials.
 */
export async function handleGoogleOAuthCallback(code: string, state: string): Promise<{ workspaceId: string }> {
  const { workspaceId } = verifyOAuthState(state);

  if (!hasLiveGoogleAppCredentials) {
    logger.warn("Google OAuth client/developer token not set — completing Google OAuth callback with mock connect");
    await mockConnectGoogle(workspaceId);
    return { workspaceId };
  }

  const tokens = await exchangeCodeForTokens(code);
  const customerId = await fetchFirstAccessibleCustomer(tokens.accessToken);
  if (!customerId) throw new Error("No accessible Google Ads customer found — grant access to at least one account and retry");

  await setGoogleOAuthConnection(workspaceId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresInSeconds: tokens.expiresIn,
    customerId,
  });

  return { workspaceId };
}

async function googleAdsSearch(customerId: string, accessToken: string, developerToken: string, query: string): Promise<any> {
  const res = await fetch(`https://googleads.googleapis.com/${ADS_API_VERSION}/customers/${customerId}/googleAds:search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, "developer-token": developerToken },
    body: JSON.stringify({ query }),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`Google Ads search failed: ${JSON.stringify(json)}`);
  return json;
}

// Mock lists returned when there's no real Google OAuth connection — same "(mock)" naming
// convention as mockConnectGoogle above, so the campaign builder always has something to
// show in local/demo mode.
// No mock account/conversion pickers: without a real Google Ads connection these are empty, so the
// connect UI prompts a real connection instead of offering fabricated "(mock)" accounts to select.

// Matches campaignOrchestrator.isAuthError — a Google Ads 401 surfaces as one of these tokens.
const isGoogleAuthError = (err: unknown) =>
  /\b401\b|UNAUTHENTICATED|invalid authentication/i.test(String((err as Error)?.message ?? err));

/**
 * Runs a read against the workspace's Google Ads credentials, recovering from a stale access
 * token the same way the mutate path (campaignOrchestrator.launchGoogleHierarchy) does. The CRM
 * SSO manual-connect stores an OPTIMISTIC tokenExpiresAt (now + 1hr), so getGoogleAdsCredentials'
 * normal expiry gate reports "still valid" and hands back the pasted token WITHOUT refreshing —
 * even though it may already be dead. That yields a 401 on the very first dropdown read after SSO.
 * On an auth error we force a genuine refresh (bypassing the expiry gate) and retry ONCE; reads
 * are idempotent so a clean retry has no side effects. Returns [] when never connected.
 */
async function withGoogleAdsCredentials<T>(
  workspaceId: string,
  fn: (credentials: GoogleAdsCredentials) => Promise<T>,
  fallback: T,
): Promise<T> {
  let credentials = await getGoogleAdsCredentials(workspaceId);
  if (!credentials) return fallback;
  try {
    return await fn(credentials);
  } catch (err) {
    if (!isGoogleAuthError(err)) throw err;
    const refreshed = await getGoogleAdsCredentials(workspaceId, { forceRefresh: true });
    if (!refreshed) throw err;
    return await fn(refreshed);
  }
}

/**
 * Full list of Google Ads accounts the connected user can access — distinct from the single
 * "first customer" fetchFirstAccessibleCustomer picks during OAuth callback (multi-account
 * picker is a follow-up there too, same as Meta's ad-account selection).
 */
export async function listAccessibleCustomers(workspaceId: string): Promise<{ id: string; name: string }[]> {
  return withGoogleAdsCredentials(workspaceId, async (credentials) => {
    const res = await fetch(`https://googleads.googleapis.com/${ADS_API_VERSION}/customers:listAccessibleCustomers`, {
      headers: { Authorization: `Bearer ${credentials.accessToken}`, "developer-token": credentials.developerToken },
    });
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(`Failed to list accessible Google Ads customers: ${JSON.stringify(json)}`);
    const ids = ((json.resourceNames ?? []) as string[]).map((rn) => rn.replace("customers/", ""));
    return ids.map((id) => ({ id, name: `Google Ads Account ${id}` }));
  }, []);
}

export async function listConversionActions(workspaceId: string): Promise<{ id: string; name: string; category: string }[]> {
  return withGoogleAdsCredentials(workspaceId, async (credentials) => {
    const json = await googleAdsSearch(
      credentials.customerId,
      credentials.accessToken,
      credentials.developerToken,
      `SELECT conversion_action.id, conversion_action.name, conversion_action.category FROM conversion_action WHERE conversion_action.status = 'ENABLED'`
    );
    return ((json.results ?? []) as any[]).map((r) => ({
      id: String(r.conversionAction.id),
      name: r.conversionAction.name,
      category: r.conversionAction.category,
    }));
  }, []);
}

export interface GoogleAdsCredentials {
  accessToken: string;
  customerId: string;
  developerToken: string;
}

/**
 * Returns a valid (refreshed if needed) access token for the workspace's connected Google
 * Ads customer, or null if not connected via real OAuth or manual connect. Unlike Meta's
 * long-lived tokens, Google access tokens expire hourly, so every call here may
 * transparently refresh and persist a new one before returning — unless the integration
 * was manually connected without a refresh token, in which case refreshing is impossible
 * and the stored access token is returned as-is (it'll fail upstream once it expires).
 * The developer token prefers a per-workspace one from a manual connect, falling back to
 * the global GOOGLE_ADS_DEVELOPER_TOKEN env var used by the OAuth-connect path.
 */
export async function getGoogleAdsCredentials(
  workspaceId: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<GoogleAdsCredentials | null> {
  const raw = await getRawGoogleTokenData(workspaceId);
  if (!raw) return null;

  const developerToken = raw.developerToken ?? GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) return null;

  if (!raw.refreshToken) {
    return { accessToken: raw.accessToken, customerId: raw.customerId, developerToken };
  }

  // forceRefresh bypasses the expiry gate. A stored token can be dead while tokenExpiresAt still
  // reads "in the future" — e.g. the CRM manual-connect path records an optimistic expiry but the
  // underlying access token was already revoked/expired at the source. In that case the normal
  // gate below never refreshes and every call 401s. The Google adapter passes forceRefresh after a
  // 401 to recover by minting a genuinely fresh token from the refresh token. See adsMutate.
  const expiresAt = new Date(raw.tokenExpiresAt).getTime();
  const stillValid = Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_SKEW_MS;
  if (!opts.forceRefresh && stillValid) {
    return { accessToken: raw.accessToken, customerId: raw.customerId, developerToken };
  }

  const refreshed = await refreshAccessToken(raw.refreshToken, raw.clientId, raw.clientSecret);
  await updateGoogleAccessToken(workspaceId, refreshed.accessToken, refreshed.expiresIn);
  return { accessToken: refreshed.accessToken, customerId: raw.customerId, developerToken };
}
