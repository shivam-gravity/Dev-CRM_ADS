import { Router } from "express";
import { startTikTokConnect, handleTikTokOAuthCallback } from "../modules/integrations/tiktokOAuth.js";
import { logger } from "../modules/logger/logger.js";
import { webAppUrl } from "./webAppUrl.js";

/**
 * Unauthenticated by design — same reasoning as metaOAuthRoutes.ts: TikTok's OAuth redirect
 * is a plain browser navigation with no Authorization header. Workspace identity travels
 * through the signed `state` param instead. Mounted before the requireAuth-gated `/api`
 * router in src/index.ts.
 */
export const tiktokOAuthRoutes = Router();

tiktokOAuthRoutes.get("/start", async (req, res) => {
  const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
  if (!workspaceId) return res.status(400).json({ error: "workspaceId query param required" });
  try {
    const result = await startTikTokConnect(workspaceId);
    if ("redirectUrl" in result) return res.redirect(result.redirectUrl);
    res.redirect(`${webAppUrl()}/profile/ad-platform-connection?connected=tiktok`);
  } catch (err) {
    logger.error("TikTok OAuth start failed", err);
    res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=tiktok_oauth_failed`);
  }
});

tiktokOAuthRoutes.get("/callback", async (req, res) => {
  const authCode = typeof req.query.auth_code === "string" ? req.query.auth_code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  if (!authCode || !state) {
    return res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=missing_code_or_state`);
  }
  try {
    await handleTikTokOAuthCallback(authCode, state);
    res.redirect(`${webAppUrl()}/profile/ad-platform-connection?connected=tiktok`);
  } catch (err) {
    logger.error("TikTok OAuth callback failed", err);
    res.redirect(`${webAppUrl()}/profile/ad-platform-connection?error=tiktok_oauth_failed`);
  }
});
