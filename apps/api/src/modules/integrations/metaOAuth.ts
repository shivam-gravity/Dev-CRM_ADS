import { logger } from "../logger/logger.js";
import { getMetaCredentials, setMetaOAuthConnection } from "./integrationService.js";
import { signOAuthState, verifyOAuthState } from "./oauthState.js";

const GRAPH_VERSION = "v22.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_OAUTH_REDIRECT_URI = process.env.META_OAUTH_REDIRECT_URI ?? "http://localhost:4000/api/integrations/meta/oauth/callback";

export const hasLiveMetaAppCredentials = Boolean(META_APP_ID && META_APP_SECRET);

export function getMetaAuthUrl(workspaceId: string): string {
  const state = signOAuthState(workspaceId);
  const params = new URLSearchParams({
    client_id: META_APP_ID ?? "",
    redirect_uri: META_OAUTH_REDIRECT_URI,
    // public_profile/email identify who connected; catalog_management is for product-catalog
    // features (Shopify/dynamic ads); instagram_basic is required for the instagram_business_account
    // lookup this file already does in fetchInstagramForPage — without it Meta rejects that field.
    scope: "ads_management,ads_read,business_management,pages_show_list,leads_retrieval,pages_manage_ads,pages_read_engagement,public_profile,email,catalog_management,instagram_basic",
    response_type: "code",
    state,
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

// Realistic-shaped mock connection (Business/Ad Account/Page/Instagram all populated) so
// the Advertising Accounts page looks right even in local/demo mode with no real Meta App
// registered — not just a bare accountId/accountName like the generic connectIntegration mock.
async function mockConnectMeta(workspaceId: string): Promise<void> {
  await setMetaOAuthConnection(workspaceId, {
    accessToken: "mock-access-token",
    expiresInSeconds: 60 * 60 * 24 * 60,
    adAccountId: "act_1000000001",
    adAccountName: "Polluxa Ads (mock)",
    currency: "USD",
    timezoneName: "America/Los_Angeles",
    accountStatus: "ACTIVE",
    pageId: "200000000001",
    pageName: "Polluxa (mock)",
    businessName: "Polluxa Marketing (mock)",
    instagramAccountId: "300000000001",
    instagramUsername: "polluxa",
    mock: true,
  });
}

/**
 * Entry point for the "Connect" button. With no Meta App registered there's nothing
 * real to redirect to — Facebook would reject an OAuth dialog with a blank client_id —
 * so this completes a mock connect immediately instead of round-tripping through
 * facebook.com. Once META_APP_ID/META_APP_SECRET are set, it returns the real dialog URL.
 */
export async function startMetaConnect(workspaceId: string): Promise<{ redirectUrl: string } | { mockConnected: true }> {
  if (!hasLiveMetaAppCredentials) {
    logger.warn("META_APP_ID/META_APP_SECRET not set — mock-connecting Meta instead of redirecting to Facebook");
    await mockConnectMeta(workspaceId);
    return { mockConnected: true };
  }
  return { redirectUrl: getMetaAuthUrl(workspaceId) };
}

async function graphGet(path: string, params: Record<string, string>): Promise<any> {
  const url = `${GRAPH_BASE}${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url);
  const json = (await res.json()) as any;
  if (!res.ok || json.error) {
    // error_user_msg is Meta's own user-facing message when present — prefer it over
    // the developer-facing `message` field (same precedence a proven reference impl uses).
    throw new Error(`Meta Graph API error on ${path}: ${json.error?.error_user_msg ?? json.error?.message ?? res.status}`);
  }
  return json;
}

export interface ValidatedMetaAdAccount {
  adAccountId: string;
  name: string;
  currency?: string;
  accountStatus?: number;
  pageName?: string;
}

/**
 * Proves a manually-pasted token/ad-account pair actually works BEFORE it is persisted.
 *
 * Without this, setMetaManualConnection stores whatever it is handed and the integration reports
 * "connected" — so a typo'd, expired, or wrong-scope token surfaces much later as a publish
 * failure, at which point the error is nowhere near its cause and looks like a bug in publishing.
 * One Graph read proves three things at once: the token is valid, it carries ads scope, and it can
 * actually see THAT ad account. It also returns the real account name, so the card can show
 * something better than the "Ad Account act_123" placeholder.
 *
 * The page is validated too when a pageId is supplied, because the page token is what lead-form
 * capture depends on — a wrong one there fails silently later, with leads simply never arriving.
 * Page failure is reported separately so a good ad account isn't rejected for a bad page.
 */
export async function validateMetaManualCredentials(input: {
  accessToken: string;
  adAccountId: string;
  pageId?: string;
  pageAccessToken?: string;
}): Promise<ValidatedMetaAdAccount> {
  // Graph needs the act_ prefix; accept either form so a user pasting the bare digits from the
  // Ads Manager URL isn't told their perfectly good account doesn't exist.
  const adAccountId = input.adAccountId.startsWith("act_") ? input.adAccountId : `act_${input.adAccountId.replace(/^act_/, "")}`;

  const account = await graphGet(`/${adAccountId}`, {
    fields: "name,currency,account_status",
    access_token: input.accessToken,
  });

  const result: ValidatedMetaAdAccount = {
    adAccountId,
    name: typeof account?.name === "string" && account.name ? account.name : `Ad Account ${adAccountId}`,
    currency: typeof account?.currency === "string" ? account.currency : undefined,
    accountStatus: typeof account?.account_status === "number" ? account.account_status : undefined,
  };

  if (input.pageId) {
    // Prefer the page token when given — that's the credential lead capture will actually use, so
    // it's the one worth proving. Falls back to the user token, which is enough to prove the page
    // is visible even when no page token was supplied.
    const page = await graphGet(`/${input.pageId}`, {
      fields: "name",
      access_token: input.pageAccessToken ?? input.accessToken,
    });
    if (typeof page?.name === "string") result.pageName = page.name;
  }

  return result;
}

async function exchangeCodeForShortLivedToken(code: string): Promise<{ accessToken: string; expiresIn: number }> {
  const json = await graphGet("/oauth/access_token", {
    client_id: META_APP_ID ?? "",
    client_secret: META_APP_SECRET ?? "",
    redirect_uri: META_OAUTH_REDIRECT_URI,
    code,
  });
  return { accessToken: json.access_token, expiresIn: json.expires_in ?? 3600 };
}

async function exchangeForLongLivedToken(shortLivedToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const json = await graphGet("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: META_APP_ID ?? "",
    client_secret: META_APP_SECRET ?? "",
    fb_exchange_token: shortLivedToken,
  });
  return { accessToken: json.access_token, expiresIn: json.expires_in ?? 60 * 60 * 24 * 60 };
}

const ACCOUNT_STATUS_LABELS: Record<number, string> = { 1: "ACTIVE", 2: "DISABLED", 3: "UNSETTLED", 7: "PENDING_RISK_REVIEW", 8: "PENDING_SETTLEMENT", 9: "IN_GRACE_PERIOD", 100: "PENDING_CLOSURE", 101: "CLOSED", 201: "ANY_ACTIVE", 202: "ANY_CLOSED" };

async function fetchFirstAdAccount(accessToken: string): Promise<{ id: string; name: string; currency: string; timezoneName?: string; accountStatus?: string; businessName?: string } | null> {
  const json = await graphGet("/me/adaccounts", { fields: "id,name,currency,timezone_name,account_status,business{name}", access_token: accessToken });
  const first = (json.data ?? [])[0];
  if (!first) return null;
  return {
    id: first.id,
    name: first.name,
    currency: first.currency ?? "USD",
    timezoneName: first.timezone_name,
    accountStatus: ACCOUNT_STATUS_LABELS[first.account_status] ?? undefined,
    // Business Manager name, when the ad account belongs to one — absent for personal ad accounts.
    businessName: first.business?.name,
  };
}

async function fetchFirstPage(accessToken: string): Promise<{ id: string; name: string } | null> {
  const json = await graphGet("/me/accounts", { fields: "id,name", access_token: accessToken });
  const first = (json.data ?? [])[0];
  return first ? { id: first.id, name: first.name } : null;
}

async function fetchInstagramForPage(accessToken: string, pageId: string): Promise<{ id: string; username: string } | null> {
  const json = await graphGet(`/${pageId}`, { fields: "instagram_business_account{id,username}", access_token: accessToken });
  const ig = json.instagram_business_account;
  return ig ? { id: ig.id, username: ig.username } : null;
}

/**
 * Completes the OAuth handshake: code -> short-lived token -> long-lived token,
 * then picks the first ad account + Page the user granted access to (multi-account
 * picker is a follow-up; today's Integration model holds one connection per platform).
 * Falls back to the existing mock connect when no Meta App is registered, so local
 * dev keeps working without real credentials.
 */
export async function handleMetaOAuthCallback(code: string, state: string): Promise<{ workspaceId: string }> {
  const { workspaceId } = verifyOAuthState(state);

  if (!hasLiveMetaAppCredentials) {
    logger.warn("META_APP_ID/META_APP_SECRET not set — completing Meta OAuth callback with mock connect");
    await mockConnectMeta(workspaceId);
    return { workspaceId };
  }

  const shortLived = await exchangeCodeForShortLivedToken(code);
  const longLived = await exchangeForLongLivedToken(shortLived.accessToken);
  const [adAccount, page] = await Promise.all([
    fetchFirstAdAccount(longLived.accessToken),
    fetchFirstPage(longLived.accessToken),
  ]);

  if (!adAccount) throw new Error("No ad account found on this Meta user — grant access to at least one ad account and retry");

  const instagram = page ? await fetchInstagramForPage(longLived.accessToken, page.id) : null;

  await setMetaOAuthConnection(workspaceId, {
    accessToken: longLived.accessToken,
    expiresInSeconds: longLived.expiresIn,
    adAccountId: adAccount.id,
    adAccountName: adAccount.name,
    currency: adAccount.currency,
    timezoneName: adAccount.timezoneName,
    accountStatus: adAccount.accountStatus,
    pageId: page?.id,
    pageName: page?.name,
    businessName: adAccount.businessName,
    instagramAccountId: instagram?.id,
    instagramUsername: instagram?.username,
  });

  return { workspaceId };
}

// Mock lists returned when there's no real Meta OAuth connection (getMetaCredentials
// returns null for mock-connected or disconnected workspaces) — same "(mock)" naming
// convention as connectIntegration's mock connect above, so the campaign builder always
// has something to show in local/demo mode.
// No mock account pickers: without a real Meta OAuth connection these lists are empty, so the
// connect UI shows "connect your Meta account" rather than fabricated "(mock)" accounts a user
// could select and appear connected against.
export async function listAdAccounts(workspaceId: string): Promise<{ id: string; name: string; currency: string; timezoneName?: string; accountStatus?: string }[]> {
  const credentials = await getMetaCredentials(workspaceId);
  if (!credentials) return [];
  const json = await graphGet("/me/adaccounts", { fields: "id,name,currency,timezone_name,account_status", access_token: credentials.accessToken });
  return (json.data ?? []).map((a: any) => ({
    id: a.id,
    name: a.name,
    currency: a.currency ?? "USD",
    timezoneName: a.timezone_name,
    accountStatus: ACCOUNT_STATUS_LABELS[a.account_status] ?? undefined,
  }));
}

export interface MetaAccountFunding {
  adAccountId: string;
  currency: string;
  /** Meta reports money amounts as integer strings in the account's minor unit (e.g. cents). We
   * pass them straight through as numbers-in-minor-units; the UI formats with the currency. */
  balanceMinor: number;
  amountSpentMinor: number;
  spendCapMinor: number | null;
  accountStatus?: string;
  /** Human label of the payment method backing the account, e.g. "VISA ****1234" / "PayPal". */
  fundingSource?: string;
  /** Deep link into Meta's own billing UI for this account — the same "Add Funds" target the CRM uses. */
  billingUrl: string;
}

/**
 * Fetch the connected Meta ad account's real funding/billing snapshot (balance, lifetime spend,
 * spend cap, currency, payment method) straight from the Graph API — the numbers the Manage Funds
 * panel shows. Meta owns the actual money (this app never holds funds), so this is read-only; the
 * "Add Funds" action deep-links to Meta's billing UI (billingUrl). Best-effort: returns null on any
 * error (no account connected, token expired, field not permissioned) so the caller degrades to the
 * internal wallet ledger rather than erroring the page.
 */
export async function getAdAccountFunding(workspaceId: string): Promise<MetaAccountFunding | null> {
  const credentials = await getMetaCredentials(workspaceId);
  if (!credentials?.adAccountId) return null;
  const bare = String(credentials.adAccountId).replace(/^act_/, "");
  try {
    const json = await graphGet(`/act_${bare}`, {
      fields: "currency,balance,amount_spent,spend_cap,account_status,funding_source_details",
      access_token: credentials.accessToken,
    });
    const num = (v: unknown): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const fs = json?.funding_source_details;
    return {
      adAccountId: bare,
      currency: typeof json?.currency === "string" ? json.currency : credentials.currency ?? "USD",
      balanceMinor: num(json?.balance),
      amountSpentMinor: num(json?.amount_spent),
      spendCapMinor: json?.spend_cap != null && num(json.spend_cap) > 0 ? num(json.spend_cap) : null,
      accountStatus: ACCOUNT_STATUS_LABELS[json?.account_status] ?? undefined,
      fundingSource: typeof fs?.display_string === "string" ? fs.display_string : undefined,
      billingUrl: `https://adsmanager.facebook.com/adsmanager/billing/?act=${bare}`,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a specific ad account's billing currency straight from Meta, given a raw token + account id
 * (i.e. before any Integration row exists). Used by the CRM SSO handoff, which receives an
 * ad-account id but not its currency — hardcoding "USD" there mis-converts every budget on non-USD
 * accounts (an INR account then fails Meta's minimum-budget check, subcode 1885272). Best-effort:
 * returns null on any error so the caller can fall back rather than block the login.
 */
export async function fetchAdAccountCurrency(accessToken: string, adAccountId: string): Promise<string | null> {
  try {
    const bare = String(adAccountId).replace(/^act_/, "");
    const json = await graphGet(`/act_${bare}`, { fields: "currency", access_token: accessToken });
    return typeof json?.currency === "string" ? json.currency : null;
  } catch {
    return null;
  }
}

export async function listPages(workspaceId: string): Promise<{ id: string; name: string }[]> {
  const credentials = await getMetaCredentials(workspaceId);
  if (!credentials) return [];
  const json = await graphGet("/me/accounts", { fields: "id,name", access_token: credentials.accessToken });
  return (json.data ?? []).map((p: any) => ({ id: p.id, name: p.name }));
}

export async function listInstagramAccounts(workspaceId: string, pageId: string): Promise<{ id: string; username: string }[]> {
  const credentials = await getMetaCredentials(workspaceId);
  if (!credentials) return [];
  const json = await graphGet(`/${pageId}`, { fields: "instagram_business_account{id,username}", access_token: credentials.accessToken });
  const ig = json.instagram_business_account;
  return ig ? [{ id: ig.id, username: ig.username }] : [];
}

export async function listPixels(workspaceId: string): Promise<{ id: string; name: string }[]> {
  const credentials = await getMetaCredentials(workspaceId);
  if (!credentials) return [];
  // The stored adAccountId already carries the "act_" prefix (e.g. "act_773958358563901"), so strip
  // any existing prefix before re-prepending — otherwise the path becomes /act_act_.../adspixels and
  // Meta 400s (which the route surfaces as a 502). Mirrors the bare-id handling used above.
  const bare = String(credentials.adAccountId).replace(/^act_/, "");
  const json = await graphGet(`/act_${bare}/adspixels`, { fields: "id,name", access_token: credentials.accessToken });
  return (json.data ?? []).map((p: any) => ({ id: p.id, name: p.name }));
}
