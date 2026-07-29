import { Router } from "express";
import { getShopifyInstallUrl, isValidCallbackHmac, handleShopifyOAuthCallback, hasLiveShopifyAppCredentials } from "../modules/integrations/shopifyOAuth.js";
import { signOAuthState, verifyOAuthState } from "../modules/integrations/oauthState.js";
import { logger } from "../modules/logger/logger.js";
import { isCatalogSourceEnabled, CATALOG_COMING_SOON_MESSAGE } from "../config/platforms.js";
import { webAppUrl } from "./webAppUrl.js";

/**
 * Unauthenticated by design, same reasoning as metaOAuthRoutes.ts/tiktokOAuthRoutes.ts —
 * Shopify's install/consent redirect is a plain browser navigation. Workspace identity
 * travels through the signed `state` param. Mounted before the requireAuth-gated `/api`
 * router in src/index.ts.
 */
export const shopifyOAuthRoutes = Router();

/** Entry point for "Connect your Shopify store" — unlike Meta/Google's single global app
 * dialog, Shopify's install flow is inherently per-merchant-store, so the merchant's own
 * `shop` domain must already be known before a redirect URL can even be built. No
 * mock-connect fallback (see shopifyOAuth.ts's own doc comment for why). */
shopifyOAuthRoutes.get("/install", (req, res) => {
  // MVP guardrail: Shopify store connection is deferred ("coming soon"). Refuse to start the
  // install flow so a store can't be linked even if this URL is hit directly (no UI leads here).
  // See config/platforms.ts (ACTIVE_CATALOG_SOURCES) to re-enable.
  if (!isCatalogSourceEnabled("shopify")) {
    return res.status(501).json({ error: CATALOG_COMING_SOON_MESSAGE, code: "CATALOG_COMING_SOON" });
  }
  const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
  const shop = typeof req.query.shop === "string" ? req.query.shop : undefined;
  if (!workspaceId || !shop) return res.status(400).json({ error: "workspaceId and shop query params are required" });
  if (!hasLiveShopifyAppCredentials) {
    return res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=shopify_not_configured`);
  }
  const state = signOAuthState(workspaceId);
  res.redirect(getShopifyInstallUrl(shop, state));
});

shopifyOAuthRoutes.get("/callback", async (req, res) => {
  // Defense-in-depth: even if a stale install redirect fires, don't complete a connection while
  // Shopify is deferred. Bounces back to the connection page with the coming-soon error.
  if (!isCatalogSourceEnabled("shopify")) {
    return res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=shopify_coming_soon`);
  }
  const shop = typeof req.query.shop === "string" ? req.query.shop : undefined;
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const query = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));

  if (!shop || !code || !state) {
    return res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=missing_shop_code_or_state`);
  }
  if (!isValidCallbackHmac(query)) {
    logger.error(`Shopify OAuth callback HMAC verification failed for shop ${shop}`);
    return res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=shopify_hmac_invalid`);
  }

  try {
    const { workspaceId } = verifyOAuthState(state);
    await handleShopifyOAuthCallback(workspaceId, shop, code);
    res.redirect(`${webAppUrl()}/profile/ad-platform-connection?connected=shopify`);
  } catch (err) {
    logger.error("Shopify OAuth callback failed", err);
    res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=shopify_oauth_failed`);
  }
});
