import { Router } from "express";
import { startGoogleConnect, handleGoogleOAuthCallback } from "../modules/integrations/googleOAuth.js";
import { OAuthNotConfiguredError } from "../modules/integrations/oauthErrors.js";
import { logger } from "../modules/logger/logger.js";
import { webAppUrl } from "./webAppUrl.js";

/**
 * Unauthenticated by design — same reasoning as metaOAuthRoutes.ts: Google's OAuth
 * redirect is a plain browser navigation with no Authorization header. Workspace
 * identity travels through the signed `state` param instead of a bearer token.
 */
export const googleOAuthRoutes = Router();

googleOAuthRoutes.get("/start", async (req, res) => {
  const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
  if (!workspaceId) return res.status(400).json({ error: "workspaceId query param required" });
  try {
    const result = await startGoogleConnect(workspaceId);
    if ("redirectUrl" in result) return res.redirect(result.redirectUrl);
    res.redirect(`${webAppUrl()}/profile/ad-platform-connection?connected=google`);
  } catch (err) {
    // See the Meta route: a missing app registration is permanent, not retryable.
    if (err instanceof OAuthNotConfiguredError) {
      logger.warn(`Google OAuth start refused: ${err.message}`);
      return res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=google_not_configured`);
    }
    logger.error("Google OAuth start failed", err);
    res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=google_oauth_failed`);
  }
});

googleOAuthRoutes.get("/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  if (!code || !state) {
    return res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=missing_code_or_state`);
  }
  try {
    await handleGoogleOAuthCallback(code, state);
    res.redirect(`${webAppUrl()}/profile/ad-platform-connection?connected=google`);
  } catch (err) {
    logger.error("Google OAuth callback failed", err);
    res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=google_oauth_failed`);
  }
});
