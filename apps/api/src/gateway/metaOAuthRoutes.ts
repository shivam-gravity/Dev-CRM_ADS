import { Router } from "express";
import { startMetaConnect, handleMetaOAuthCallback } from "../modules/integrations/metaOAuth.js";
import { OAuthNotConfiguredError } from "../modules/integrations/oauthErrors.js";
import { logger } from "../modules/logger/logger.js";
import { webAppUrl } from "./webAppUrl.js";

/**
 * Unauthenticated by design — Facebook's OAuth redirect is a plain browser
 * navigation with no Authorization header. Workspace identity travels through
 * the signed `state` param (see metaOAuth.ts) instead of the usual bearer token.
 * Mounted before the requireAuth-gated `/api` router in src/index.ts.
 */
export const metaOAuthRoutes = Router();

metaOAuthRoutes.get("/start", async (req, res) => {
  const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
  if (!workspaceId) return res.status(400).json({ error: "workspaceId query param required" });
  try {
    const result = await startMetaConnect(workspaceId);
    if ("redirectUrl" in result) return res.redirect(result.redirectUrl);
    res.redirect(`${webAppUrl()}/profile/ad-platform-connection?connected=meta`);
  } catch (err) {
    // A missing app registration is not a transient failure, so it must not be reported as one —
    // "Please try again" sends the user in circles when the only way forward is manual credentials.
    // A distinct code lets the UI say that, without forwarding raw error text into a query string.
    if (err instanceof OAuthNotConfiguredError) {
      logger.warn(`Meta OAuth start refused: ${err.message}`);
      return res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=meta_not_configured`);
    }
    logger.error("Meta OAuth start failed", err);
    res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=meta_oauth_failed`);
  }
});

metaOAuthRoutes.get("/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  if (!code || !state) {
    return res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=missing_code_or_state`);
  }
  try {
    await handleMetaOAuthCallback(code, state);
    res.redirect(`${webAppUrl()}/profile/ad-platform-connection?connected=meta`);
  } catch (err) {
    logger.error("Meta OAuth callback failed", err);
    res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=meta_oauth_failed`);
  }
});
