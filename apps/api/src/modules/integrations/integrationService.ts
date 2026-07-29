import { randomUUID } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { encryptToken, decryptToken } from "../../infra/crypto.js";

export interface Integration {
  id: string;
  workspaceId: string;
  platform: "meta" | "google" | "tiktok" | "shopify" | "woocommerce" | "pixel";
  status: "connected" | "disconnected" | "error" | "pending";
  accountName?: string;
  accountId?: string;
  permissions: string[];
  settings: Record<string, unknown>;
  connectedAt?: string;
  errorMessage?: string;
  updatedAt: string;
}

const DEFAULT_INTEGRATIONS: Omit<Integration, "id" | "workspaceId" | "updatedAt">[] = [
  { platform: "meta", status: "disconnected", permissions: ["ads_management", "ads_read", "business_management"], settings: {} },
  { platform: "google", status: "disconnected", permissions: ["https://www.googleapis.com/auth/adwords"], settings: {} },
  { platform: "tiktok", status: "disconnected", permissions: ["ad.read", "campaign.read", "report.read"], settings: {} },
  { platform: "shopify", status: "disconnected", permissions: ["read_products", "read_orders", "read_customers"], settings: {} },
  { platform: "woocommerce", status: "disconnected", permissions: ["read_products", "read_orders"], settings: {} },
  { platform: "pixel", status: "disconnected", permissions: [], settings: { pixelId: "", events: [] } },
];

async function save(i: Integration): Promise<void> {
  await prisma.integration.upsert({
    where: { id: i.id },
    create: { id: i.id, workspaceId: i.workspaceId, platform: i.platform, data: i as any, updatedAt: new Date(i.updatedAt) },
    update: { data: i as any, updatedAt: new Date(i.updatedAt) },
  });
}

export async function getOrCreateIntegrations(workspaceId: string): Promise<Integration[]> {
  const rows = await prisma.integration.findMany({ where: { workspaceId } });
  if (rows.length > 0) return rows.map((r) => r.data as unknown as Integration);

  const integrations = DEFAULT_INTEGRATIONS.map((d) => ({ ...d, id: randomUUID(), workspaceId, updatedAt: new Date().toISOString() } as Integration));
  for (const i of integrations) await save(i);
  return integrations;
}

export async function connectIntegration(workspaceId: string, platform: Integration["platform"], mockAccountName: string): Promise<Integration> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform } });
  const existing = row ? (row.data as unknown as Integration) : DEFAULT_INTEGRATIONS.find((d) => d.platform === platform)!;

  const updated: Integration = {
    ...existing,
    id: row?.id ?? randomUUID(),
    workspaceId,
    status: "connected",
    accountName: mockAccountName,
    accountId: `act_${Math.floor(Math.random() * 9000000) + 1000000}`,
    connectedAt: new Date().toISOString(),
    errorMessage: undefined,
    updatedAt: new Date().toISOString(),
  };
  await save(updated);
  return updated;
}

export async function disconnectIntegration(workspaceId: string, platform: Integration["platform"]): Promise<Integration> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform } });
  if (!row) throw new Error("Integration not found");
  const existing = row.data as unknown as Integration;
  const updated: Integration = { ...existing, id: row.id, status: "disconnected", accountName: undefined, accountId: undefined, connectedAt: undefined, updatedAt: new Date().toISOString() };
  await save(updated);
  return updated;
}

export async function updateIntegrationSettings(workspaceId: string, platform: Integration["platform"], settings: Record<string, unknown>): Promise<Integration> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform } });
  if (!row) throw new Error("Integration not found");
  const existing = row.data as unknown as Integration;
  const updated: Integration = { ...existing, id: row.id, settings: { ...existing.settings, ...settings }, updatedAt: new Date().toISOString() };
  await save(updated);
  return updated;
}

export interface MetaOAuthConnectionInput {
  accessToken: string;
  expiresInSeconds: number;
  adAccountId: string;
  adAccountName: string;
  currency: string;
  timezoneName?: string;
  accountStatus?: string;
  pageId?: string;
  /** Page-scoped access token for Page-permission-gated Graph endpoints (leadgen_forms/leads),
   * distinct from the ad-account token. Encrypted into settings.pageAccessTokenEncrypted, which
   * getMetaCredentials already reads. Falls back to the ad-account token when not supplied. */
  pageAccessToken?: string;
  pageName?: string;
  /** Business Manager name owning the ad account — distinct from the ad account's own name (e.g. "Polluxa Marketing" vs. "Polluxa Ads"). */
  businessName?: string;
  instagramAccountId?: string;
  instagramUsername?: string;
  /**
   * Set by metaOAuth.ts's mockConnectMeta — a mock connection has no real, usable access
   * token, so it must NOT be encrypted/stored the way a real one is. getMetaCredentials
   * treats a missing accessTokenEncrypted as "not connected" and returns null, which is
   * exactly what every call site (campaign builder selectors, reach estimates, launches)
   * needs in order to correctly fall back to their own mock/heuristic data instead of
   * attempting a real Graph API call with a fake token.
   */
  mock?: boolean;
}

/** Persists a real Meta OAuth connection (encrypted token) after metaOAuth.ts completes the handshake. */
export async function setMetaOAuthConnection(workspaceId: string, input: MetaOAuthConnectionInput): Promise<Integration> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform: "meta" } });
  const existing = row ? (row.data as unknown as Integration) : DEFAULT_INTEGRATIONS.find((d) => d.platform === "meta")!;

  const updated: Integration = {
    ...existing,
    id: row?.id ?? randomUUID(),
    workspaceId,
    platform: "meta",
    status: "connected",
    accountName: input.adAccountName,
    accountId: input.adAccountId,
    connectedAt: new Date().toISOString(),
    errorMessage: undefined,
    settings: {
      ...existing.settings,
      // Explicitly cleared (not just omitted) for a mock connection — existing.settings may
      // carry a stale real/mock token from a previous connect, which would otherwise survive
      // the spread above and make getMetaCredentials think this is a usable real connection.
      ...(input.mock
        ? { accessTokenEncrypted: undefined, tokenExpiresAt: undefined, pageAccessTokenEncrypted: undefined }
        : {
            accessTokenEncrypted: encryptToken(input.accessToken),
            tokenExpiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
            // Only overwrite the stored page token when the caller actually supplied one — a
            // reconnect that omits it should preserve the previously-stored pageAccessTokenEncrypted.
            ...(input.pageAccessToken ? { pageAccessTokenEncrypted: encryptToken(input.pageAccessToken) } : {}),
          }),
      currency: input.currency,
      timezoneName: input.timezoneName,
      accountStatus: input.accountStatus,
      pageId: input.pageId,
      pageName: input.pageName,
      businessName: input.businessName,
      instagramAccountId: input.instagramAccountId,
      instagramUsername: input.instagramUsername,
    },
    updatedAt: new Date().toISOString(),
  };
  await save(updated);
  return updated;
}

export interface MetaCredentials {
  accessToken: string;
  adAccountId: string;
  pageId?: string;
  /** Page-scoped token for leadgen_forms/leads calls, distinct from the ad-account token above — Meta's Graph API often requires a Page access token (not a user/ad-account token) for Page-permission-gated endpoints. Falls back to `accessToken` when not set (the OAuth-connect path only ever stores one token today). */
  pageAccessToken?: string;
  /** Ad account's billing currency (e.g. "USD", "JPY") — Meta's minor-unit conversion varies by currency (see metaAdapter's currency divisor table). */
  currency: string;
}

/** Decrypts and returns the connected Meta ad account's live token, or null if not connected via real OAuth or manual connect. */
export async function getMetaCredentials(workspaceId: string): Promise<MetaCredentials | null> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform: "meta" } });
  if (!row) return null;
  const integration = row.data as unknown as Integration;
  const tokenEncrypted = integration.settings?.accessTokenEncrypted as string | undefined;
  if (integration.status !== "connected" || !tokenEncrypted || !integration.accountId) return null;
  const pageAccessTokenEncrypted = integration.settings?.pageAccessTokenEncrypted as string | undefined;
  return {
    accessToken: decryptToken(tokenEncrypted),
    adAccountId: integration.accountId,
    pageId: integration.settings?.pageId as string | undefined,
    pageAccessToken: pageAccessTokenEncrypted ? decryptToken(pageAccessTokenEncrypted) : undefined,
    currency: (integration.settings?.currency as string | undefined) ?? "USD",
  };
}

/**
 * Flags a Meta connection as errored (status: "error" + errorMessage) so the UI surfaces a
 * "reconnect your Meta account" prompt instead of silently failing every publish. Called when a
 * live Graph call fails with an unrecoverable auth error AND a token refresh couldn't fix it
 * (see launchMetaHierarchy) — i.e. the stored token is truly dead (de-authorized app, password
 * change, revoked permission), not merely expired-but-refreshable. Best-effort: a failure to
 * write this status must never mask the original launch error, so callers ignore its result.
 */
export async function markMetaConnectionError(workspaceId: string, errorMessage: string): Promise<void> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform: "meta" } });
  if (!row) return;
  const existing = row.data as unknown as Integration;
  // Only downgrade a currently-"connected" integration — never resurrect a disconnected one into "error".
  if (existing.status !== "connected") return;
  const updated: Integration = { ...existing, id: row.id, status: "error", errorMessage: errorMessage.slice(0, 300), updatedAt: new Date().toISOString() };
  await save(updated);
}

export interface MetaManualConnectionInput {
  accessToken: string;
  adAccountId: string;
  pageId?: string;
  pageAccessToken?: string;
  /** Real names resolved by validateMetaManualCredentials — so the card shows the actual account/page
   * instead of the "Ad Account act_123" placeholder. Optional so callers that skip validation still work. */
  accountName?: string;
  pageName?: string;
}

/**
 * "Manual Connect (Testing)" path — lets a developer paste tokens copied from Meta's
 * Graph API Explorer directly, bypassing the OAuth redirect (useful before META_APP_ID/
 * META_APP_SECRET are registered, or to point at a specific ad account/page without
 * going through the picker). Mirrors setMetaOAuthConnection's persistence shape so
 * getMetaCredentials/metaAdapter/metaLeadSync work identically either way.
 */
export async function setMetaManualConnection(workspaceId: string, input: MetaManualConnectionInput): Promise<Integration> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform: "meta" } });
  const existing = row ? (row.data as unknown as Integration) : DEFAULT_INTEGRATIONS.find((d) => d.platform === "meta")!;

  const updated: Integration = {
    ...existing,
    id: row?.id ?? randomUUID(),
    workspaceId,
    platform: "meta",
    status: "connected",
    // A freshly validated name wins over whatever was stored before — a re-connect pointed at a
    // different ad account must not keep displaying the previous account's name.
    accountName: input.accountName ?? existing.accountName ?? `Ad Account ${input.adAccountId}`,
    accountId: input.adAccountId,
    connectedAt: new Date().toISOString(),
    errorMessage: undefined,
    settings: {
      ...existing.settings,
      accessTokenEncrypted: encryptToken(input.accessToken),
      pageId: input.pageId ?? existing.settings?.pageId,
      pageName: input.pageName ?? existing.settings?.pageName,
      // A manual connect is a REAL connection — clear any leftover mock marker from a previous
      // placeholder connect, or the UI would keep labelling this "Demo only".
      mock: undefined,
      pageAccessTokenEncrypted: input.pageAccessToken ? encryptToken(input.pageAccessToken) : existing.settings?.pageAccessTokenEncrypted,
      connectionMethod: "manual",
    },
    updatedAt: new Date().toISOString(),
  };
  await save(updated);
  return updated;
}

export interface GoogleOAuthConnectionInput {
  refreshToken: string;
  accessToken: string;
  expiresInSeconds: number;
  customerId: string;
  customerName?: string;
  /** Set by googleOAuth.ts's mockConnectGoogle — see MetaOAuthConnectionInput.mock for why a mock connection must not store an encrypted (fake) token. */
  mock?: boolean;
}

/** Persists a real Google OAuth connection (encrypted tokens) after googleOAuth.ts completes the handshake. */
export async function setGoogleOAuthConnection(workspaceId: string, input: GoogleOAuthConnectionInput): Promise<Integration> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform: "google" } });
  const existing = row ? (row.data as unknown as Integration) : DEFAULT_INTEGRATIONS.find((d) => d.platform === "google")!;

  const updated: Integration = {
    ...existing,
    id: row?.id ?? randomUUID(),
    workspaceId,
    platform: "google",
    status: "connected",
    accountName: input.customerName ?? `Customer ${input.customerId}`,
    accountId: input.customerId,
    connectedAt: new Date().toISOString(),
    errorMessage: undefined,
    settings: {
      ...existing.settings,
      // Explicitly cleared (not just omitted) for a mock connection — see the identical
      // comment in setMetaOAuthConnection for why a stale token from existing.settings must
      // not survive the spread above.
      ...(input.mock
        ? { accessTokenEncrypted: undefined, refreshTokenEncrypted: undefined, tokenExpiresAt: undefined }
        : {
            refreshTokenEncrypted: encryptToken(input.refreshToken),
            accessTokenEncrypted: encryptToken(input.accessToken),
            tokenExpiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
          }),
    },
    updatedAt: new Date().toISOString(),
  };
  await save(updated);
  return updated;
}

export interface RawGoogleTokenData {
  /** Empty when manually connected without a refresh token — see setGoogleManualConnection. Callers must treat "" as "cannot refresh, use accessToken as-is." */
  refreshToken: string;
  accessToken: string;
  tokenExpiresAt: string;
  customerId: string;
  /** Per-workspace developer token from a manual connect, if one was provided — takes precedence over the global GOOGLE_ADS_DEVELOPER_TOKEN env var when set. */
  developerToken?: string;
  /** Per-workspace OAuth client credentials from a manual connect, used to refresh this integration's token instead of the global GOOGLE_OAUTH_CLIENT_ID/SECRET. */
  clientId?: string;
  clientSecret?: string;
}

/**
 * Raw (still-encrypted-until-here) token read, with no refresh logic — Google access
 * tokens expire hourly and refreshing requires calling Google's token endpoint, which
 * would create a circular import if it lived here (googleOAuth.ts already imports this
 * module to persist connections). See googleOAuth.getGoogleAdsCredentials for the
 * refresh-aware wrapper that callers should actually use. refreshTokenEncrypted is NOT
 * required (unlike accessTokenEncrypted) — a manual connect may not have one, in which
 * case refreshToken comes back as "" and the caller skips refreshing entirely.
 */
export async function getRawGoogleTokenData(workspaceId: string): Promise<RawGoogleTokenData | null> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform: "google" } });
  if (!row) return null;
  const integration = row.data as unknown as Integration;
  const accessTokenEncrypted = integration.settings?.accessTokenEncrypted as string | undefined;
  if (integration.status !== "connected" || !accessTokenEncrypted || !integration.accountId) return null;
  const refreshTokenEncrypted = integration.settings?.refreshTokenEncrypted as string | undefined;
  const developerTokenEncrypted = integration.settings?.developerTokenEncrypted as string | undefined;
  const clientSecretEncrypted = integration.settings?.clientSecretEncrypted as string | undefined;
  return {
    refreshToken: refreshTokenEncrypted ? decryptToken(refreshTokenEncrypted) : "",
    accessToken: decryptToken(accessTokenEncrypted),
    tokenExpiresAt: integration.settings?.tokenExpiresAt as string,
    customerId: integration.accountId,
    developerToken: developerTokenEncrypted ? decryptToken(developerTokenEncrypted) : undefined,
    clientId: integration.settings?.clientId as string | undefined,
    clientSecret: clientSecretEncrypted ? decryptToken(clientSecretEncrypted) : undefined,
  };
}

export interface GoogleManualConnectionInput {
  customerId: string;
  developerToken: string;
  accessToken: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
}

/**
 * "Manual Connect (Testing)" path — lets a developer paste a customer ID + developer
 * token + access token (optionally with OAuth client credentials + refresh token) copied
 * from the Google Ads API Center, bypassing the consent-screen redirect. Without a refresh
 * token, the connection works until the pasted access token expires (~1hr) and then needs
 * reconnecting — that tradeoff is inherent to skipping the OAuth flow, not a bug.
 */
export async function setGoogleManualConnection(workspaceId: string, input: GoogleManualConnectionInput): Promise<Integration> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform: "google" } });
  const existing = row ? (row.data as unknown as Integration) : DEFAULT_INTEGRATIONS.find((d) => d.platform === "google")!;

  const updated: Integration = {
    ...existing,
    id: row?.id ?? randomUUID(),
    workspaceId,
    platform: "google",
    status: "connected",
    accountName: existing.accountName ?? `Customer ${input.customerId}`,
    accountId: input.customerId,
    connectedAt: new Date().toISOString(),
    errorMessage: undefined,
    settings: {
      ...existing.settings,
      accessTokenEncrypted: encryptToken(input.accessToken),
      refreshTokenEncrypted: input.refreshToken ? encryptToken(input.refreshToken) : undefined,
      developerTokenEncrypted: encryptToken(input.developerToken),
      clientId: input.clientId,
      clientSecretEncrypted: input.clientSecret ? encryptToken(input.clientSecret) : undefined,
      // No refresh token means we can't know a real expiry — assume Google's typical 1hr
      // access-token lifetime so getGoogleAdsCredentials treats it as fresh until then.
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      connectionMethod: "manual",
    },
    updatedAt: new Date().toISOString(),
  };
  await save(updated);
  return updated;
}

/** Updates just the access token + expiry after a refresh — refreshToken/customerId are untouched. */
export async function updateGoogleAccessToken(workspaceId: string, accessToken: string, expiresInSeconds: number): Promise<void> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform: "google" } });
  if (!row) throw new Error("Google integration not found");
  const existing = row.data as unknown as Integration;
  const updated: Integration = {
    ...existing,
    settings: {
      ...existing.settings,
      accessTokenEncrypted: encryptToken(accessToken),
      tokenExpiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  await save(updated);
}

export interface TikTokOAuthConnectionInput {
  accessToken: string;
  expiresInSeconds: number;
  advertiserId: string;
  advertiserName: string;
  /** Set by tiktokOAuth.ts's mockConnectTikTok — see MetaOAuthConnectionInput.mock for why a
   * mock connection must not store an encrypted (fake) token. */
  mock?: boolean;
}

/** Persists a real TikTok OAuth connection (encrypted token) after tiktokOAuth.ts completes the handshake. */
export async function setTikTokOAuthConnection(workspaceId: string, input: TikTokOAuthConnectionInput): Promise<Integration> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform: "tiktok" } });
  const existing = row ? (row.data as unknown as Integration) : DEFAULT_INTEGRATIONS.find((d) => d.platform === "tiktok")!;

  const updated: Integration = {
    ...existing,
    id: row?.id ?? randomUUID(),
    workspaceId,
    platform: "tiktok",
    status: "connected",
    accountName: input.advertiserName,
    accountId: input.advertiserId,
    connectedAt: new Date().toISOString(),
    errorMessage: undefined,
    settings: {
      ...existing.settings,
      ...(input.mock
        ? { accessTokenEncrypted: undefined, tokenExpiresAt: undefined }
        : { accessTokenEncrypted: encryptToken(input.accessToken), tokenExpiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString() }),
    },
    updatedAt: new Date().toISOString(),
  };
  await save(updated);
  return updated;
}

export interface TikTokCredentials {
  accessToken: string;
  advertiserId: string;
}

/** Decrypts and returns the connected TikTok ad account's live token, or null if not connected via real OAuth. */
export async function getTikTokCredentials(workspaceId: string): Promise<TikTokCredentials | null> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform: "tiktok" } });
  if (!row) return null;
  const integration = row.data as unknown as Integration;
  const tokenEncrypted = integration.settings?.accessTokenEncrypted as string | undefined;
  if (integration.status !== "connected" || !tokenEncrypted || !integration.accountId) return null;
  return { accessToken: decryptToken(tokenEncrypted), advertiserId: integration.accountId };
}

export interface ShopifyOAuthConnectionInput {
  shopDomain: string;
  accessToken: string;
  expiresInSeconds: number;
  /** Present when Shopify issued an expiring token (the 2026-required default) — absent
   * would mean a legacy permanent token, which getShopifyCredentials treats as never needing
   * a refresh. */
  refreshToken?: string;
  refreshTokenExpiresInSeconds?: number;
}

/** Persists a real Shopify app-install connection (encrypted tokens) after shopifyOAuth.ts completes the handshake. */
export async function setShopifyOAuthConnection(workspaceId: string, input: ShopifyOAuthConnectionInput): Promise<Integration> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform: "shopify" } });
  const existing = row ? (row.data as unknown as Integration) : DEFAULT_INTEGRATIONS.find((d) => d.platform === "shopify")!;

  const updated: Integration = {
    ...existing,
    id: row?.id ?? randomUUID(),
    workspaceId,
    platform: "shopify",
    status: "connected",
    accountName: input.shopDomain,
    accountId: input.shopDomain,
    connectedAt: new Date().toISOString(),
    errorMessage: undefined,
    settings: {
      ...existing.settings,
      accessTokenEncrypted: encryptToken(input.accessToken),
      refreshTokenEncrypted: input.refreshToken ? encryptToken(input.refreshToken) : undefined,
      tokenExpiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  await save(updated);
  return updated;
}

export interface RawShopifyTokenData {
  shopDomain: string;
  accessToken: string;
  /** Empty when connected via a legacy non-expiring token — callers must treat "" as "cannot refresh, use accessToken as-is." */
  refreshToken: string;
  tokenExpiresAt: string;
}

/** Raw (still-encrypted-until-here) token read, no refresh logic — see shopifyOAuth.getShopifyCredentials for the refresh-aware wrapper callers should actually use (same split as googleOAuth.ts/getRawGoogleTokenData, to avoid a circular import between this file and shopifyOAuth.ts). */
export async function getRawShopifyTokenData(workspaceId: string): Promise<RawShopifyTokenData | null> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform: "shopify" } });
  if (!row) return null;
  const integration = row.data as unknown as Integration;
  const accessTokenEncrypted = integration.settings?.accessTokenEncrypted as string | undefined;
  if (integration.status !== "connected" || !accessTokenEncrypted || !integration.accountId) return null;
  const refreshTokenEncrypted = integration.settings?.refreshTokenEncrypted as string | undefined;
  return {
    shopDomain: integration.accountId,
    accessToken: decryptToken(accessTokenEncrypted),
    refreshToken: refreshTokenEncrypted ? decryptToken(refreshTokenEncrypted) : "",
    tokenExpiresAt: integration.settings?.tokenExpiresAt as string,
  };
}

/** Updates the access token (+ refresh token, since Shopify rotates it on every refresh — unlike Google, which reuses the same refresh token) after a refresh. */
export async function updateShopifyAccessToken(workspaceId: string, accessToken: string, expiresInSeconds: number, refreshToken?: string): Promise<void> {
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform: "shopify" } });
  if (!row) throw new Error("Shopify integration not found");
  const existing = row.data as unknown as Integration;
  const updated: Integration = {
    ...existing,
    settings: {
      ...existing.settings,
      accessTokenEncrypted: encryptToken(accessToken),
      ...(refreshToken ? { refreshTokenEncrypted: encryptToken(refreshToken) } : {}),
      tokenExpiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  await save(updated);
}

const SECRET_SETTINGS_KEYS = ["accessTokenEncrypted", "refreshTokenEncrypted", "pageAccessTokenEncrypted", "developerTokenEncrypted", "clientSecretEncrypted"] as const;

/**
 * Strips encrypted OAuth tokens out of `settings` before an Integration is sent to the
 * browser — the frontend only ever needs the display fields (pageId/pageName/currency/
 * timezoneName/accountStatus/lastLeadSyncAt etc.), never the ciphertext itself. Every
 * route that returns an Integration to the client should go through this.
 */
export function sanitizeIntegration(i: Integration): Integration {
  const settings = { ...i.settings };
  for (const key of SECRET_SETTINGS_KEYS) delete settings[key];
  return { ...i, settings };
}
