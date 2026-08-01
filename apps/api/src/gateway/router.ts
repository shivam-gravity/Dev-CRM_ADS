import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { asyncHandler } from "./asyncHandler.js";
import { sendError } from "./errorResponse.js";
import { objectStorage } from "../infra/objectStorage.js";
import { proxyTo } from "./proxy.js";
import { prisma } from "../db/prisma.js";
import {
  requireNotificationAccess, requireAssetAccess, requireInsightAccess, requireSavedAudienceAccess,
  requireDraftAccess, requireDeveloperWebhookAccess, requireAutomationRuleAccess, requireGenerationJobAccess,
  requireStrategyAccess, requireStrategyAccessFromBody, requireCreativeAccess, requireCampaignAccess, requireAdSetAccess, requireAdAccess,
  requireCompetitorAccess,
} from "./middleware/resourceOwnership.js";
import { competitorAdRefreshQueue } from "../infra/queue.js";
import { getCompanyProfile } from "../research/company-knowledge/CompanyKnowledgeBuilder.js";
import { getCampaignRecommendations } from "../research/campaign-recommendation/CampaignRecommendationEngine.js";

import { logger } from "../modules/logger/logger.js";
import { requireWorkspaceMember, requireBusinessAccess } from "./middleware/workspaceAccess.js";
import { requireOpsAccess } from "./middleware/opsAuth.js";
import { getMembership } from "../modules/workspace/workspaceService.js";
import type { AuthedRequest } from "./middleware/auth.js";

// Generic ceiling for ad-spend fields — prevents an obviously-wrong value (e.g. a
// misplaced decimal) from being accepted with no upper bound. Adjust per business need.
const MAX_BUDGET_CENTS = 100_000_000; // $1,000,000
import { createBusiness, getBusiness, listBusinesses, updateBusiness } from "../modules/business/businessService.js";
import { generateStrategy, getStrategy, listStrategiesForBusiness, createStrategyFromResearch } from "../modules/strategy/strategyEngine.js";
import { getCampaignTrend } from "../modules/analytics/analyticsService.js";
import { scrapeUrl } from "../modules/onboarding/scraper.js";
import { analyzeAudience, analyzeProduct, runDeepResearch } from "../modules/onboarding/analysis.js";
import { findCachedSession, cloneSessionFromCache, createResearchSession, getResearchSession } from "../modules/onboarding/researchSessionService.js";
import {
  listCreatives,
  getCreative,
  createCreative,
  deleteCreative,
  generateCreativeVariations,
} from "../modules/orchestrator/creativesService.js";
import { getAnalyticsSummary, getAudienceSuggestions } from "../modules/analytics/analyticsService.js";
import { getAdInsights } from "../modules/adInsights/adInsightsService.js";
import { chatWithStrategist } from "../modules/strategist/strategistService.js";
import { chatWithCopilot } from "../modules/copilot/copilotService.js";
import { launchCampaign, pauseVariant, activateVariant, reallocateBudget, applyCreativeMedia, deleteCampaign, buildCampaignFromStrategy, CampaignLaunchedDeleteError } from "../modules/orchestrator/campaignOrchestrator.js";
import { ingestCampaignMetrics } from "../modules/pipeline/performancePipeline.js";
import { runOptimizationPass } from "../modules/optimization/optimizationEngine.js";
import { metaAdapter } from "../modules/adapters/metaAdapter.js";
import { googleAdapter } from "../modules/adapters/googleAdapter.js";
import { isValidObjective, listObjectives } from "../modules/adapters/metaObjectives.js";
import { simulateBudget } from "../modules/adapters/budgetSimulator.js";

// scraper-service is the only extracted service that actually runs; its routes are proxied
// (see scraperProxy below). Auth and campaigns are handled inline in this gateway.
const SCRAPER_SERVICE_URL = process.env.SCRAPER_SERVICE_URL ?? "http://localhost:4003";

import { listNotifications, markRead, markAllRead, unreadCount, createNotification } from "../modules/notifications/notificationService.js";
import { listAssets, createAsset, deleteAsset, updateAssetTags } from "../modules/assets/assetService.js";
import { listInsights, dismissInsight, generateInsights, recordOptimizationInsights } from "../modules/insights/insightService.js";
import { getOrCreateIntegrations, connectIntegration, disconnectIntegration, updateIntegrationSettings, getMetaCredentials, sanitizeIntegration, setMetaManualConnection, setGoogleManualConnection } from "../modules/integrations/integrationService.js";
import { listAdAccounts as listMetaAdAccountsGraph, listPages as listMetaPagesGraph, listInstagramAccounts as listMetaInstagramAccountsGraph, listPixels as listMetaPixelsGraph, getAdAccountFunding, validateMetaManualCredentials, checkAdAccountCanSpend } from "../modules/integrations/metaOAuth.js";
import { MetaGraphError } from "../modules/adapters/metaAdapter.js";
import { buildFeasibilityProjection } from "../modules/orchestrator/budgetStructure.js";
import { getWalletBalance, listWalletTransactions } from "../modules/billing/walletService.js";
import { confirmPixelLive } from "../modules/integrations/metaPixelHelper.js";
import { listMetaLeadForms } from "../modules/leadgen/metaLeadSync.js";
import { listAccessibleCustomers as listGoogleCustomersApi, listConversionActions as listGoogleConversionActionsApi, getGoogleAdsCredentials, validateGoogleManualCredentials } from "../modules/integrations/googleOAuth.js";
import { getProductCatalog } from "../modules/integrations/productCatalogService.js";
import { createGenerationJob, getGenerationJob } from "../modules/generation/generationJobService.js";
import { getCrmWebhookConfig, setCrmWebhookConfig, clearCrmWebhookConfig } from "../modules/crm/crmWebhookService.js";
import { creativeGenerationQueue, researchSessionQueue, researchOrchestratorQueue, campaignGenerationQueue } from "../infra/queue.js";
import { createResearchJob, getResearchJob as getResearchOrchestratorJob, getResearchJobWithExecutions } from "../research/research-orchestrator/index.js";
import { toStrategyInput } from "../research/knowledge/toStrategyInput.js";
import { createCampaignGenerationJob, getCampaignGenerationJob } from "../modules/orchestrator/campaignGenerationService.js";
import { TOTAL_PIPELINE_UNITS } from "../modules/orchestrator/campaignGenerationPipeline.js";
import { finishCampaignGenerationBuild } from "../modules/orchestrator/deferredCampaignBuild.js";
import { buildCampaignForSelectedStrategy } from "../modules/orchestrator/strategySelectionService.js";
import { getProgressSteps } from "../infra/liveProgress.js";
import { freshnessScore, isStale } from "../research/knowledge/freshness.js";
import { listDeadLetterEntries } from "../infra/deadLetterQueue.js";
import {
  listSavedAudiences,
  createSavedAudience,
  updateSavedAudience,
  deleteSavedAudience,
  getSavedAudience,
} from "../modules/audience/savedAudienceService.js";
import { buildMetaTargetingSpec, fetchMetaReachEstimate, estimateReachHeuristic } from "../modules/adapters/metaTargetingMapper.js";
import { createCustomAudience, createLookalikeAudience, addUsersToCustomAudience } from "../modules/adapters/metaAudienceSync.js";
import {
  listDrafts, createDraft, updateDraft, publishDraft, deleteDraft, scheduleDraft,
  listAdSets, createAdSet, listAds, createAd, updateAd,
} from "../modules/drafts/draftsService.js";
import { listSupportTickets, createSupportTicket } from "../modules/support/supportTicketService.js";
import { getNotificationPreferences, setNotificationPreferences } from "../modules/notifications/notificationPreferenceService.js";
import { getRbacMatrix, setRbacMatrix } from "../modules/admin/rbacService.js";
import {
  listDeveloperWebhooks, createDeveloperWebhook, deleteDeveloperWebhook,
  getOrCreateApiKey, regenerateApiKey,
} from "../modules/admin/developerPortalService.js";
import { getPaymentMethod, setPaymentMethod, validatePaymentMethodInput } from "../modules/billing/paymentMethodService.js";
import { listAutomationRules, createAutomationRule, deleteAutomationRule } from "../modules/automation/automationRuleService.js";
import { getOptimizationGoal, setOptimizationGoal } from "../modules/optimization/optimizationGoalService.js";
import { ACTIVE_NETWORKS, isCatalogSourceEnabled, CATALOG_COMING_SOON_MESSAGE } from "../config/platforms.js";

export const router = Router();

// Register/login/google are mounted unauthenticated, ahead of requireAuth, in index.ts
// (see authEntryRouter below) — a client has no bearer token yet when calling them, so
// gating them behind requireAuth would be a chicken-and-egg 401 in production.
import { authRateLimiter } from "./middleware/rateLimit.js";

export const authEntryRouter = Router();

import { crmLogin } from "../modules/auth/crmAuthService.js";
import { rotateRefreshToken, revokeAllForUser } from "../modules/auth/refreshTokenService.js";
import { issueToken, register, login, googleAuth } from "../modules/auth/authService.js";

// Handled inline against the local authService (auth-service was never built). Each returns
// { user, token, refreshToken, workspaceId } — the exact shape the web client's AuthResponse
// expects. Rate-limited like the rest of the unauthenticated entry points.
authEntryRouter.post("/auth/register", authRateLimiter, asyncHandler(async (req, res) => {
  const { name, email, password } = req.body ?? {};
  if (!name || !email || !password) return res.status(400).json({ error: "name, email and password are required" });
  try {
    res.json(await register({ name, email, password }));
  } catch (err: any) {
    res.status(409).json({ error: err.message || "Registration failed" });
  }
}));

authEntryRouter.post("/auth/login", authRateLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });
  try {
    res.json(await login(email, password));
  } catch (err: any) {
    res.status(401).json({ error: err.message || "Invalid email or password" });
  }
}));

authEntryRouter.post("/auth/google", authRateLimiter, asyncHandler(async (req, res) => {
  const { name, email, googleId } = req.body ?? {};
  if (!name || !email || !googleId) return res.status(400).json({ error: "name, email and googleId are required" });
  try {
    res.json(await googleAuth(name, email, googleId));
  } catch (err: any) {
    res.status(401).json({ error: err.message || "Google authentication failed" });
  }
}));

authEntryRouter.post("/auth/crm-login", authRateLimiter, asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== "string") return res.status(400).json({ error: "Missing token" });
  try {
    const result = await crmLogin(token);
    res.json(result);
  } catch (err: any) {
    res.status(401).json({ error: err.message || "CRM authentication failed" });
  }
}));

authEntryRouter.post("/auth/refresh", asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken || typeof refreshToken !== "string") return res.status(400).json({ error: "Missing refreshToken" });
  try {
    const { newPlaintext, userId, family } = await rotateRefreshToken(refreshToken);
    const member = await prisma.workspaceMember.findFirst({ where: { userId }, orderBy: { joinedAt: "asc" } });
    const accessToken = issueToken(userId, member?.workspaceId);
    res.json({ accessToken, refreshToken: newPlaintext });
  } catch (err: any) {
    res.status(401).json({ error: err.message || "Refresh failed" });
  }
}));

/* ═══════════════════════════════════════════════
   AUTH — handled inline in this gateway
   ═══════════════════════════════════════════════ */

router.post("/auth/logout", asyncHandler(async (req: AuthedRequest, res) => {
  await revokeAllForUser(req.userId!);
  res.json({ ok: true });
}));

router.get("/auth/me", asyncHandler(async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ id: user.id, email: user.email, name: user.name, avatar: user.avatar ?? undefined, createdAt: user.createdAt.toISOString() });
}));

router.patch("/auth/me", asyncHandler(async (req: AuthedRequest, res) => {
  const user = await prisma.user.update({ where: { id: req.userId! }, data: req.body });
  res.json({ id: user.id, email: user.email, name: user.name, avatar: user.avatar ?? undefined, createdAt: user.createdAt.toISOString() });
}));

/* ═══════════════════════════════════════════════
   WORKSPACES — handled inline in this gateway
   ═══════════════════════════════════════════════ */

router.get("/workspaces/:id", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const ws = await prisma.workspace.findUnique({ where: { id: req.params.id } });
  if (!ws) return res.status(404).json({ error: "Workspace not found" });
  res.json({ id: ws.id, name: ws.name, ownerId: ws.ownerId, plan: ws.plan, logoUrl: ws.logoUrl, timezone: ws.timezone, createdAt: ws.createdAt.toISOString() });
}));

router.patch("/workspaces/:id", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const ws = await prisma.workspace.update({ where: { id: req.params.id }, data: req.body });
  res.json({ id: ws.id, name: ws.name, ownerId: ws.ownerId, plan: ws.plan, logoUrl: ws.logoUrl, timezone: ws.timezone, createdAt: ws.createdAt.toISOString() });
}));

router.get("/workspaces/:id/members", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const members = await prisma.workspaceMember.findMany({ where: { workspaceId: req.params.id }, include: { workspace: false } });
  res.json(members);
}));

router.post("/workspaces/:id/members/invite", requireWorkspaceMember("params", "id"), asyncHandler(async (_req, res) => {
  res.status(501).json({ error: "Auth service not running" });
}));
router.patch("/workspaces/members/:memberId/role", asyncHandler(async (_req, res) => {
  res.status(501).json({ error: "Auth service not running" });
}));
router.delete("/workspaces/members/:memberId", asyncHandler(async (_req, res) => {
  res.status(501).json({ error: "Auth service not running" });
}));

/* ═══════════════════════════════════════════════
   NOTIFICATIONS
   ═══════════════════════════════════════════════ */

router.get("/workspaces/:id/notifications", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  res.json(await listNotifications(req.params.id));
}));

router.get("/workspaces/:id/notifications/count", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  res.json({ count: await unreadCount(req.params.id) });
}));

router.patch("/notifications/:id/read", requireNotificationAccess, asyncHandler(async (req, res) => {
  try { res.json(await markRead(req.params.id)); }
  catch (err) { sendError(res, err, 404, "Not found"); }
}));

router.post("/workspaces/:id/notifications/read-all", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  await markAllRead(req.params.id);
  res.status(204).send();
}));

/* ═══════════════════════════════════════════════
   ASSETS
   ═══════════════════════════════════════════════ */

router.get("/workspaces/:id/assets", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const type = req.query.type as string | undefined;
  res.json(await listAssets(req.params.id, type as any));
}));

router.post("/workspaces/:id/assets", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1),
    type: z.enum(["image", "video", "logo", "font", "template"]),
    url: z.string().url(),
    thumbnailUrl: z.string().url().optional(),
    size: z.number().int().nonnegative(),
    mimeType: z.string(),
    tags: z.array(z.string()).optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.status(201).json(await createAsset(req.params.id, { ...parsed.data, tags: parsed.data.tags ?? [] }));
}));

router.delete("/assets/:id", requireAssetAccess, asyncHandler(async (req, res) => {
  const deleted = await deleteAsset(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
}));

router.patch("/assets/:id/tags", requireAssetAccess, asyncHandler(async (req, res) => {
  const parsed = z.object({ tags: z.array(z.string()) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try { res.json(await updateAssetTags(req.params.id, parsed.data.tags)); }
  catch (err) { sendError(res, err, 404, "Not found"); }
}));

const assetUploadSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(["image", "video", "logo", "font", "template"]),
  mimeType: z.string().min(1),
  dataBase64: z.string().min(1),
  tags: z.array(z.string()).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

router.post("/workspaces/:id/assets/upload", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = assetUploadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const buffer = Buffer.from(parsed.data.dataBase64, "base64");
  const safeName = parsed.data.name.replace(/[^a-z0-9.\-_]/gi, "_");
  const key = `${req.params.id}/${randomUUID()}-${safeName}`;

  try {
    const { url } = await objectStorage.put(key, buffer, parsed.data.mimeType);
    const asset = await createAsset(req.params.id, {
      name: parsed.data.name,
      type: parsed.data.type,
      url,
      size: buffer.length,
      mimeType: parsed.data.mimeType,
      tags: parsed.data.tags ?? [],
      width: parsed.data.width,
      height: parsed.data.height,
    });
    res.status(201).json(asset);
  } catch (err) {
    logger.error("Asset upload failed", err);
    res.status(500).json({ error: "Upload failed" });
  }
}));

/* ═══════════════════════════════════════════════
   AI INSIGHTS
   ═══════════════════════════════════════════════ */

router.get("/workspaces/:workspaceId/insights", requireWorkspaceMember("params", "workspaceId"), asyncHandler(async (req, res) => {
  let results = await listInsights(req.params.workspaceId);
  if (results.length === 0) {
    const { businessId } = req.query as { businessId?: string };
    if (businessId) {
      results = await generateInsights(req.params.workspaceId, businessId);
    }
  }
  res.json(results);
}));

router.post("/workspaces/:workspaceId/insights/generate", requireWorkspaceMember("params", "workspaceId"), asyncHandler(async (req, res) => {
  const { businessId } = req.query as { businessId?: string };
  if (!businessId) return res.status(400).json({ error: "businessId query param required" });
  if (!(await getBusiness(businessId))) return res.status(404).json({ error: "Business not found" });
  try {
    res.json(await generateInsights(req.params.workspaceId, businessId));
  } catch (err) {
    sendError(res, err, 502, "Insight generation failed");
  }
}));

router.patch("/insights/:id/dismiss", requireInsightAccess, asyncHandler(async (req, res) => {
  try { res.json(await dismissInsight(req.params.id)); }
  catch (err) { sendError(res, err, 404, "Not found"); }
}));

/* ═══════════════════════════════════════════════
   INTEGRATIONS
   ═══════════════════════════════════════════════ */

router.get("/workspaces/:id/integrations", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => res.json((await getOrCreateIntegrations(req.params.id)).map(sanitizeIntegration))));

const INTEGRATION_PLATFORMS = ["meta", "google", "tiktok", "shopify", "woocommerce", "pixel"] as const;

router.post("/workspaces/:id/integrations/:platform/connect", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const platform = req.params.platform as any;
  if (!INTEGRATION_PLATFORMS.includes(platform)) return res.status(400).json({ error: `Unknown platform "${platform}"` });
  const { accountName } = req.body;
  try {
    res.json(sanitizeIntegration(await connectIntegration(req.params.id, platform, accountName ?? "My Ad Account")));
  } catch (err) {
    sendError(res, err, 400, "Connect failed");
  }
}));

router.post("/workspaces/:id/integrations/:platform/disconnect", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  try { res.json(sanitizeIntegration(await disconnectIntegration(req.params.id, req.params.platform as any))); }
  catch (err) { sendError(res, err, 400, "Disconnect failed"); }
}));

router.patch("/workspaces/:id/integrations/:platform/settings", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  try { res.json(sanitizeIntegration(await updateIntegrationSettings(req.params.id, req.params.platform as any, req.body ?? {}))); }
  catch (err) { sendError(res, err, 400, "Settings update failed"); }
}));

const metaManualConnectSchema = z.object({
  accessToken: z.string().trim().min(1),
  adAccountId: z.string().trim().min(1),
  pageId: z.string().trim().min(1).optional(),
  pageAccessToken: z.string().trim().min(1).optional(),
});

router.post("/workspaces/:id/integrations/meta/connect-manual", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = metaManualConnectSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, parsed.error, 400, "Invalid manual connect payload");
  try {
    // Prove the credentials work against the Graph API BEFORE storing them. Persisting first would
    // mark the integration "connected" on a bad paste and defer the real error to publish time,
    // where it looks like a publishing bug rather than a wrong token.
    const validated = await validateMetaManualCredentials(parsed.data);
    const integration = await setMetaManualConnection(req.params.id, {
      ...parsed.data,
      adAccountId: validated.adAccountId, // normalized to the act_ prefix Graph requires
      accountName: validated.name,
      pageName: validated.pageName,
      // validateMetaManualCredentials already read this off the Graph account — persisting it is
      // what keeps budget floors and every money label in the ad account's real currency.
      currency: validated.currency,
      country: validated.country,
    });
    res.json(sanitizeIntegration(integration));
  } catch (err) {
    // Meta's own message reaches the user here (graphGet prefers error_user_msg), which is what
    // makes a wrong token actionable instead of a generic failure.
    sendError(res, err, 400, "Manual connect failed");
  }
}));

const googleManualConnectSchema = z.object({
  customerId: z.string().trim().min(1),
  developerToken: z.string().trim().min(1),
  accessToken: z.string().trim().min(1),
  clientId: z.string().trim().min(1).optional(),
  clientSecret: z.string().trim().min(1).optional(),
  refreshToken: z.string().trim().min(1).optional(),
});

router.post("/workspaces/:id/integrations/google/connect-manual", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = googleManualConnectSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, parsed.error, 400, "Invalid manual connect payload");
  try {
    // Same reasoning as the Meta route: listAccessibleCustomers exercises the access token AND the
    // developer token, and confirms this login can actually reach the customer being connected.
    const validated = await validateGoogleManualCredentials(parsed.data);
    const integration = await setGoogleManualConnection(req.params.id, { ...parsed.data, customerId: validated.customerId });
    res.json(sanitizeIntegration(integration));
  } catch (err) {
    sendError(res, err, 400, "Manual connect failed");
  }
}));

// Full account/page/Instagram/pixel lists for the campaign builder's selector dropdowns —
// distinct from the single-account picker the OAuth callback stores (metaOAuth.ts). Falls
// back to mock data when there's no live Meta connection so the builder always has options.
router.get("/workspaces/:id/integrations/meta/ad-accounts", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  try { res.json(await listMetaAdAccountsGraph(req.params.id)); }
  catch (err) { sendError(res, err, 502, "Failed to list Meta ad accounts"); }
}));

router.get("/workspaces/:id/integrations/meta/pages", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  try { res.json(await listMetaPagesGraph(req.params.id)); }
  catch (err) { sendError(res, err, 502, "Failed to list Meta pages"); }
}));

router.get("/workspaces/:id/integrations/meta/pages/:pageId/instagram-accounts", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  try { res.json(await listMetaInstagramAccountsGraph(req.params.id, req.params.pageId)); }
  catch (err) { sendError(res, err, 502, "Failed to list Instagram accounts"); }
}));

// ?adAccountId= scopes the list to the account the CAMPAIGN targets, which can differ from the
// workspace default (campaign.metaAdAccountId). Pixels are owned per ad account, so listing the
// default account's pixels while the campaign publishes into another one offered only choices that
// were guaranteed to be rejected at publish. Omitted → the workspace default, as before.
router.get("/workspaces/:id/integrations/meta/pixels", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const adAccountId = typeof req.query.adAccountId === "string" ? req.query.adAccountId : undefined;
  try { res.json(await listMetaPixelsGraph(req.params.id, adAccountId)); }
  catch (err) { sendError(res, err, 502, "Failed to list Meta pixels"); }
}));

// Instant (lead-gen) forms on the connected Page, for the builder's Lead Ads picker. Attaching one
// switches the campaign from website conversions to on-Meta lead collection, which is what makes a
// small budget viable — the leads themselves already flow back through the leadgen webhook.
router.get("/workspaces/:id/integrations/meta/lead-forms", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  try { res.json({ forms: await listMetaLeadForms(req.params.id) }); }
  catch (err) { sendError(res, err, 502, "Failed to list Meta lead forms"); }
}));

// Backs the campaign-builder "confirm pixel is live" gate: checks the live Graph API for whether
// the pixel is available AND firing recent events, so the UI can enable generation only once the
// pixel is confirmed. Same enforcement runs server-side in POST /campaigns/generate below.
router.get("/workspaces/:id/integrations/meta/pixels/:pixelId/confirm", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  try { res.json(await confirmPixelLive(req.params.id, req.params.pixelId)); }
  catch (err) { sendError(res, err, 502, "Failed to confirm Meta pixel status"); }
}));

router.get("/workspaces/:id/integrations/google/customers", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  try { res.json(await listGoogleCustomersApi(req.params.id)); }
  catch (err) { sendError(res, err, 502, "Failed to list Google Ads customers"); }
}));

router.get("/workspaces/:id/integrations/google/conversion-actions", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  try { res.json(await listGoogleConversionActionsApi(req.params.id)); }
  catch (err) { sendError(res, err, 502, "Failed to list Google conversion actions"); }
}));

/* ═══════════════════════════════════════════════
   SAVED AUDIENCES / DEMOGRAPHIC TARGETING
   ═══════════════════════════════════════════════ */

const savedAudienceFields = z.object({
  name: z.string().trim().min(1),
  type: z.enum(["saved", "custom", "lookalike", "interest_group"]).default("saved"),
  platform: z.enum(["meta", "google"]).nullable().optional(),
  lookalikeSourceId: z.string().nullable().optional(),
  metaCustomAudienceId: z.string().nullable().optional(),
  ageMin: z.number().int().min(13).max(65),
  ageMax: z.number().int().min(13).max(65),
  gender: z.enum(["all", "male", "female"]).default("all"),
  locations: z.array(z.string()).default([]),
  interests: z.array(z.string()).default([]),
  exclusions: z.array(z.string()).default([]),
});

const ageRangeValid = (data: { ageMin?: number; ageMax?: number }) =>
  data.ageMin === undefined || data.ageMax === undefined || data.ageMin <= data.ageMax;
const ageRangeRefinement = { message: "ageMin must be less than or equal to ageMax", path: ["ageMax"] };

const savedAudienceSchema = savedAudienceFields.refine(ageRangeValid, ageRangeRefinement);
const savedAudienceUpdateSchema = savedAudienceFields.partial().refine(ageRangeValid, ageRangeRefinement);

router.get("/workspaces/:id/audiences", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => res.json(await listSavedAudiences(req.params.id))));

router.post("/workspaces/:id/audiences", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = savedAudienceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    res.status(201).json(await createSavedAudience(req.params.id, parsed.data));
  } catch (err) {
    sendError(res, err, 409, "Failed to create audience");
  }
}));

// Create a real Meta Custom Audience (optionally seeding it with a hashed customer list) and save
// it locally with its Meta id so it can be targeted on a launched ad set (see buildMetaTargetingSpec
// custom_audiences injection). Degrades to a mock audience id when no Meta account is connected.
const customAudienceSchema = z.object({
  name: z.string().trim().min(1),
  subtype: z.enum(["CUSTOM", "WEBSITE", "APP", "OFFLINE", "ENGAGEMENT"]).default("CUSTOM"),
  description: z.string().trim().optional(),
  emails: z.array(z.string()).optional(),
  phones: z.array(z.string()).optional(),
  ageMin: z.number().int().min(13).max(65).default(18),
  ageMax: z.number().int().min(13).max(65).default(65),
  gender: z.enum(["all", "male", "female"]).default("all"),
  locations: z.array(z.string()).default([]),
});
router.post("/workspaces/:id/audiences/custom", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = customAudienceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const creds = await getMetaCredentials(req.params.id);
    const created = await createCustomAudience(
      { adAccountId: creds?.adAccountId ?? "", name: parsed.data.name, subtype: parsed.data.subtype, description: parsed.data.description, customerFileSource: "USER_PROVIDED_ONLY" },
      creds ?? undefined,
    );
    if ((parsed.data.emails?.length || parsed.data.phones?.length) && creds) {
      await addUsersToCustomAudience(created.externalId, { emails: parsed.data.emails, phones: parsed.data.phones }, creds).catch(() => { /* best-effort seed */ });
    }
    const saved = await createSavedAudience(req.params.id, {
      name: parsed.data.name, type: "custom", platform: "meta", metaCustomAudienceId: created.externalId,
      ageMin: parsed.data.ageMin, ageMax: parsed.data.ageMax, gender: parsed.data.gender,
      locations: parsed.data.locations, interests: [], exclusions: [],
    });
    res.status(201).json(saved);
  } catch (err) {
    sendError(res, err, 502, "Failed to create Meta Custom Audience");
  }
}));

// Create a Meta Lookalike from an existing source Custom Audience (must already have a Meta id —
// a lookalike needs a real seed audience). Saves it locally with its own Meta id.
const lookalikeSchema = z.object({
  name: z.string().trim().min(1),
  sourceAudienceId: z.string().min(1),
  ratio: z.number().min(0.01).max(0.20).default(0.01),
  targetCountries: z.array(z.string()).default(["US"]),
});
router.post("/workspaces/:id/audiences/lookalike", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = lookalikeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const source = await getSavedAudience(parsed.data.sourceAudienceId);
  if (!source || source.workspaceId !== req.params.id) return res.status(404).json({ error: "Source audience not found" });
  if (!source.metaCustomAudienceId) {
    return res.status(400).json({ error: "The source audience has no Meta Custom Audience — upload a seed customer list to create one first." });
  }
  try {
    const creds = await getMetaCredentials(req.params.id);
    const created = await createLookalikeAudience(
      { adAccountId: creds?.adAccountId ?? "", name: parsed.data.name, originAudienceId: source.metaCustomAudienceId, targetCountries: parsed.data.targetCountries, ratio: parsed.data.ratio },
      creds ?? undefined,
    );
    const saved = await createSavedAudience(req.params.id, {
      name: parsed.data.name, type: "lookalike", platform: "meta",
      lookalikeSourceId: source.id, metaCustomAudienceId: created.externalId,
      ageMin: source.ageMin, ageMax: source.ageMax, gender: source.gender,
      locations: parsed.data.targetCountries, interests: [], exclusions: [],
    });
    res.status(201).json(saved);
  } catch (err) {
    sendError(res, err, 502, "Failed to create Meta Lookalike Audience");
  }
}));

router.patch("/audiences/:id", requireSavedAudienceAccess, asyncHandler(async (req, res) => {
  const parsed = savedAudienceUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try { res.json(await updateSavedAudience(req.params.id, parsed.data)); }
  catch (err) { sendError(res, err, 404, "Not found"); }
}));

router.delete("/audiences/:id", requireSavedAudienceAccess, asyncHandler(async (req, res) => {
  const deleted = await deleteSavedAudience(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
}));

router.post("/workspaces/:id/audiences/:audienceId/reach-estimate", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const audience = await getSavedAudience(req.params.audienceId);
  if (!audience) return res.status(404).json({ error: "Not found" });

  const credentials = await getMetaCredentials(req.params.id);
  if (!credentials) return res.json(estimateReachHeuristic(audience));

  try {
    const targeting = await buildMetaTargetingSpec(credentials.accessToken, audience, credentials.country);
    res.json(await fetchMetaReachEstimate(credentials.accessToken, credentials.adAccountId, targeting));
  } catch (err) {
    sendError(res, err, 502, "Meta reach estimate failed");
  }
}));

const ephemeralReachEstimateSchema = z.object({
  locations: z.array(z.string()).default([]),
  interests: z.array(z.string()).default([]),
  ageMin: z.number().int().min(13).max(65).default(18),
  ageMax: z.number().int().min(13).max(65).default(65),
  gender: z.enum(["all", "male", "female"]).default("all"),
});

// Same reach-estimate machinery as above, but for the campaign builder's audience gauge
// where the targeting hasn't been (and may never be) saved as a SavedAudience.
router.post("/workspaces/:id/reach-estimate", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = ephemeralReachEstimateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const audience = { id: "ephemeral", workspaceId: req.params.id, name: "ephemeral", exclusions: [], createdAt: new Date().toISOString(), ...parsed.data };

  const credentials = await getMetaCredentials(req.params.id);
  if (!credentials) return res.json(estimateReachHeuristic(audience));

  try {
    const targeting = await buildMetaTargetingSpec(credentials.accessToken, audience, credentials.country);
    res.json(await fetchMetaReachEstimate(credentials.accessToken, credentials.adAccountId, targeting));
  } catch (err) {
    sendError(res, err, 502, "Meta reach estimate failed");
  }
}));

/* ═══════════════════════════════════════════════
   CRM OUTBOUND WEBHOOK CONFIG (Stage E)
   ═══════════════════════════════════════════════ */

const crmWebhookConfigSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(1).nullable().optional(),
});

router.get("/workspaces/:id/crm-webhook", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const config = await getCrmWebhookConfig(req.params.id);
  // Never return the secret — same treatment as an OAuth token, only "is one set" matters here.
  res.json({ url: config?.url ?? null, configured: Boolean(config) });
}));

router.put("/workspaces/:id/crm-webhook", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = crmWebhookConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  await setCrmWebhookConfig(req.params.id, parsed.data);
  res.status(204).send();
}));

router.delete("/workspaces/:id/crm-webhook", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  await clearCrmWebhookConfig(req.params.id);
  res.status(204).send();
}));

/* ═══════════════════════════════════════════════
   AI CREATIVE GENERATION
   ═══════════════════════════════════════════════ */

const generationJobSchema = z.object({
  businessId: z.string().min(1),
  productUrl: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1).optional(),
  wantVideo: z.boolean().default(false),
  aspectRatio: z.enum(["square", "portrait", "landscape"]).optional(),
  language: z.string().trim().min(1).optional(),
  quality: z.enum(["standard", "high"]).optional(),
  // How many distinct angle-diverse creatives to produce (standalone image jobs only; the service
  // clamps to [1, MAX_CREATIVE_VARIANTS] and forces 1 for video/fatigue-refresh).
  variantCount: z.number().int().min(1).max(8).optional(),
}).refine((v) => v.productUrl || v.prompt, { message: "Either productUrl or prompt is required" });

router.post("/workspaces/:id/generation-jobs", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = generationJobSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const job = await createGenerationJob(req.params.id, parsed.data);
  await creativeGenerationQueue.add("generate", { jobId: job.id });
  res.status(202).json(job);
}));

router.get("/generation-jobs/:id", requireGenerationJobAccess, asyncHandler(async (req, res) => {
  const job = await getGenerationJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
}));

const catalogSourceSchema = z.enum(["all", "shopify", "facebook", "google", "woocommerce"]);
router.get("/workspaces/:id/products", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = catalogSourceSchema.safeParse(req.query.source ?? "all");
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  // MVP guardrail: all store/catalog sync sources are deferred ("coming soon"). Reject any
  // explicit source here so a hand-crafted request can't import from a store even if the UI is
  // bypassed. "all" is allowed through and returns an empty set below (no source is enabled), so
  // the picker degrades to an empty state rather than erroring on its default load. See
  // config/platforms.ts (ACTIVE_CATALOG_SOURCES) to re-enable a source.
  if (parsed.data !== "all" && !isCatalogSourceEnabled(parsed.data)) {
    return res.status(501).json({ error: CATALOG_COMING_SOON_MESSAGE, code: "CATALOG_COMING_SOON" });
  }
  res.json(await getProductCatalog(req.params.id, parsed.data));
}));

/* ═══════════════════════════════════════════════
   DRAFTS
   ═══════════════════════════════════════════════ */

router.get("/workspaces/:id/drafts", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  res.json(await listDrafts(req.params.id));
}));

router.post("/workspaces/:id/drafts", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1),
    type: z.enum(["campaign", "ad_set", "ad"]),
    data: z.record(z.unknown()),
    aiRecommendation: z.string().optional(),
    score: z.number().optional(),
    scheduledAt: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.status(201).json(await createDraft(req.params.id, parsed.data));
}));

const draftUpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  type: z.enum(["campaign", "ad_set", "ad"]).optional(),
  status: z.enum(["draft", "review", "scheduled", "published"]).optional(),
  data: z.record(z.unknown()).optional(),
  aiRecommendation: z.string().optional(),
  score: z.number().optional(),
  scheduledAt: z.string().optional(),
  publishedAt: z.string().optional(),
});

router.patch("/drafts/:id", requireDraftAccess, asyncHandler(async (req, res) => {
  const parsed = draftUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try { res.json(await updateDraft(req.params.id, parsed.data)); }
  catch (err) { sendError(res, err, 404, "Not found"); }
}));

router.post("/drafts/:id/publish", requireDraftAccess, asyncHandler(async (req, res) => {
  try { res.json(await publishDraft(req.params.id)); }
  catch (err) { sendError(res, err, 404, "Not found"); }
}));

router.post("/drafts/:id/schedule", requireDraftAccess, asyncHandler(async (req, res) => {
  const { scheduledAt } = req.body;
  if (!scheduledAt) return res.status(400).json({ error: "scheduledAt required" });
  try { res.json(await scheduleDraft(req.params.id, scheduledAt)); }
  catch (err) { sendError(res, err, 404, "Not found"); }
}));

router.delete("/drafts/:id", requireDraftAccess, asyncHandler(async (req, res) => {
  const deleted = await deleteDraft(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
}));

/* ═══════════════════════════════════════════════
   AD SETS & ADS
   ═══════════════════════════════════════════════ */

router.get("/campaigns/:id/ad-sets", requireCampaignAccess, asyncHandler(async (req, res) => res.json(await listAdSets(req.params.id))));

router.post("/campaigns/:id/ad-sets", requireCampaignAccess, asyncHandler(async (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1),
    status: z.enum(["active", "paused", "draft"]).default("draft"),
    dailyBudgetCents: z.number().int().positive().max(MAX_BUDGET_CENTS),
    targeting: z.record(z.unknown()).default({}),
    placements: z.array(z.string()).default([]),
    bidStrategy: z.string().default("lowest_cost"),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.status(201).json(await createAdSet(req.params.id, parsed.data));
}));

router.get("/ad-sets/:id/ads", requireAdSetAccess, asyncHandler(async (req, res) => res.json(await listAds(req.params.id))));

router.post("/ad-sets/:id/ads", requireAdSetAccess, asyncHandler(async (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1),
    status: z.enum(["active", "paused", "draft", "rejected"]).default("draft"),
    creative: z.object({
      headline: z.string(),
      body: z.string(),
      callToAction: z.string(),
      imageUrl: z.string().optional(),
    }),
    format: z.enum(["single_image", "carousel", "video", "collection"]).default("single_image"),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.status(201).json(await createAd(req.params.id, parsed.data));
}));

const adUpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  status: z.enum(["active", "paused", "draft", "rejected"]).optional(),
  creative: z.object({
    headline: z.string(),
    body: z.string(),
    callToAction: z.string(),
    imageUrl: z.string().optional(),
  }).optional(),
  format: z.enum(["single_image", "carousel", "video", "collection"]).optional(),
});

router.patch("/ads/:id", requireAdAccess, asyncHandler(async (req, res) => {
  const parsed = adUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try { res.json(await updateAd(req.params.id, parsed.data)); }
  catch (err) { sendError(res, err, 404, "Not found"); }
}));

/* ═══════════════════════════════════════════════
   BUSINESSES (existing)
   ═══════════════════════════════════════════════ */

const businessProfileFields = {
  name: z.string().trim().min(1),
  // Empty string is allowed as an explicit "clear the website" signal (a partial PATCH can't
  // otherwise unset it); domainFromWebsite treats "" as null, so the queryable domain clears too.
  website: z.union([z.string().url(), z.literal("")]).optional(),
  industry: z.string().trim().min(1),
  monthlyBudgetCents: z.number().int().positive().max(MAX_BUDGET_CENTS),
  goals: z.array(z.string()).min(1),
  targetAudience: z.string().optional(),
  brandName: z.string().trim().min(1).optional(),
  logoUrls: z.array(z.string()).max(5).optional(),
};
const businessCreateSchema = z.object({ workspaceId: z.string().min(1), ...businessProfileFields });
// workspaceId is deliberately excluded here too (not just at the service layer) — moving a
// business to a different workspace isn't a normal profile edit.
const businessUpdateSchema = z.object(businessProfileFields).partial();

router.post("/businesses", requireWorkspaceMember("body", "workspaceId"), asyncHandler(async (req, res) => {
  const parsed = businessCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    res.status(201).json(await createBusiness(parsed.data));
  } catch (err) {
    sendError(res, err, 409, "Failed to create business");
  }
}));

router.get("/businesses", asyncHandler(async (req: AuthedRequest, res) => {
  const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
  if (!workspaceId) return res.status(400).json({ error: "workspaceId query param required" });
  if (!(await getMembership(workspaceId, req.userId!))) {
    return res.status(403).json({ error: "You do not have access to this workspace" });
  }
  res.json(await listBusinesses(workspaceId));
}));

router.get("/businesses/:id", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => {
  const business = await getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: "Not found" });
  res.json(business);
}));

router.patch("/businesses/:id", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => {
  const business = await getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: "Not found" });
  const parsed = businessUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(await updateBusiness(req.params.id, parsed.data));
}));

router.post("/businesses/:id/strategies", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => {
  const business = await getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: "Business not found" });
  try {
    const strategy = await generateStrategy(business);
    res.status(201).json(strategy);
  } catch (err) {
    sendError(res, err, 502, "Strategy generation failed");
  }
}));

router.post("/businesses/:id/strategies/from-research", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => {
  const business = await getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: "Business not found" });
  const researchSessionId = typeof req.body?.researchSessionId === "string" ? req.body.researchSessionId : undefined;
  const researchJobId = typeof req.body?.researchJobId === "string" ? req.body.researchJobId : undefined;
  if (!researchSessionId && !researchJobId) return res.status(400).json({ error: "researchSessionId or researchJobId is required" });

  try {
    if (researchJobId) {
      // New parallel-provider pipeline: ResearchJob.context (a ResearchContext) is
      // remapped into the same ResearchStrategyInput shape the legacy branch below
      // already builds, so createStrategyFromResearch — the "AI Agents" step — stays
      // the single implementation for both pipelines.
      const job = await getResearchOrchestratorJob(researchJobId);
      if (!job || job.status !== "completed" || !job.context) {
        return res.status(409).json({ error: "Research job is not complete" });
      }
      const strategy = await createStrategyFromResearch(business.id, toStrategyInput(job.context));
      return res.status(201).json(strategy);
    }

    const session = await getResearchSession(researchSessionId!);
    if (!session || session.status !== "done" || !session.result) {
      return res.status(409).json({ error: "Research session is not complete" });
    }
    const strategy = await createStrategyFromResearch(business.id, session.result as any);
    res.status(201).json(strategy);
  } catch (err) {
    sendError(res, err, 502, "Failed to build strategy from research");
  }
}));


router.get("/businesses/:id/strategies", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => res.json(await listStrategiesForBusiness(req.params.id))));

// The persisted Company Knowledge Builder output (research/company-knowledge/
// CompanyKnowledgeBuilder.ts) — assembled once per successful research run rather than
// reconstructed on every request. 404 when no research has completed for this business yet.
router.get("/businesses/:id/company-profile", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => {
  const profile = await getCompanyProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: "No company profile has been generated for this business yet" });
  res.json(profile);
}));

// Every Competitor row for this business, with its latest CompetitorProfile (Competitor
// Intelligence Engine's persisted output — research/competitor-intelligence/*) — the
// relational, queryable/rankable form of what previously only lived in Research Memory.
router.get("/businesses/:id/competitors", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => {
  const competitors = await prisma.competitor.findMany({
    where: { businessId: req.params.id },
    orderBy: { createdAt: "desc" },
    include: { profiles: { orderBy: { generatedAt: "desc" }, take: 1 } },
  });
  res.json(
    competitors.map((c) => ({
      id: c.id,
      name: c.name,
      domain: c.domain,
      status: c.status,
      refreshIntervalDays: c.refreshIntervalDays,
      lastEnrichedAt: c.lastEnrichedAt,
      latestProfile: c.profiles[0] ?? null,
    }))
  );
}));

// Manual, on-demand override of the daily competitor-ad-refresh schedule (infra/queue.js's
// COMPETITOR_AD_REFRESH_QUEUE, competitorAdRefreshWorker.ts) — for a business owner who
// doesn't want to wait for the next scheduled tick.
router.post("/businesses/:id/competitors/:competitorId/refresh", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => {
  const competitor = await prisma.competitor.findUnique({ where: { id: req.params.competitorId } });
  if (!competitor || competitor.businessId !== req.params.id) {
    return res.status(404).json({ error: "Competitor not found for this business" });
  }
  await competitorAdRefreshQueue.add("refresh-one-competitor", { competitorId: competitor.id });
  res.status(202).json({ enqueued: true, competitorId: competitor.id });
}));

// A single competitor's discovered ads (Ad Intelligence Engine — research/ad-intelligence/
// CompetitorAdDiscovery.ts) plus each ad's per-ad creative breakdown when analyzed
// (research/creative-intelligence/AdCreativeAnalyzer.ts). Bare-id route (no business/
// workspace context in the URL), so ownership is resolved via requireCompetitorAccess.
router.get("/competitors/:id/ads", requireCompetitorAccess, asyncHandler(async (req, res) => {
  const ads = await prisma.competitorAd.findMany({
    where: { competitorId: req.params.id },
    orderBy: [{ isActive: "desc" }, { lastSeenAt: "desc" }],
    include: { creativeAnalysis: true },
  });
  res.json(ads);
}));
router.get("/strategies/:id", requireStrategyAccess, asyncHandler(async (req, res) => {
  const strategy = await getStrategy(req.params.id);
  if (!strategy) return res.status(404).json({ error: "Not found" });
  res.json(strategy);
}));

// Analytics
router.get("/businesses/:id/analytics/summary", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => {
  const period = (req.query.period as "all" | "month" | "week") ?? "all";
  res.json(await getAnalyticsSummary(req.params.id, period));
}));

router.get("/businesses/:id/audience-suggestions", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => {
  try { res.json(await getAudienceSuggestions(req.params.id)); }
  catch (err) { sendError(res, err, 502, "Audience suggestion failed"); }
}));

router.get("/businesses/:id/ad-insights", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => {
  const parsed = z.enum(["meta", "google", "tiktok", "bing"]).safeParse(req.query.network ?? "meta");
  if (!parsed.success) return res.status(400).json({ error: "Invalid network" });
  res.json(await getAdInsights(req.params.id, parsed.data));
}));

const strategistChatSchema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1) })).min(1),
});
router.post("/businesses/:id/strategist/chat", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => {
  const business = await getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: "Business not found" });
  const parsed = strategistChatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const reply = await chatWithStrategist(req.params.id, parsed.data.messages);
    res.json({ reply });
  } catch (err) {
    sendError(res, err, 502, "Strategist chat failed");
  }
}));

router.post("/businesses/:id/copilot/chat", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => {
  const business = await getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: "Business not found" });
  const parsed = strategistChatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const reply = await chatWithCopilot(req.params.id, parsed.data.messages);
    res.json({ reply });
  } catch (err) {
    sendError(res, err, 502, "Copilot chat failed");
  }
}));

// Creatives
const creativeSchema = z.object({
  headline: z.string().trim().min(1).max(100),
  body: z.string().trim().min(1).max(500),
  callToAction: z.string().trim().min(1).max(50),
  format: z.enum(["text", "image", "video"]).optional(),
  tags: z.array(z.string()).optional(),
});

router.get("/businesses/:id/creatives", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => res.json(await listCreatives(req.params.id))));
router.post("/businesses/:id/creatives", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => {
  const parsed = creativeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.status(201).json(await createCreative(req.params.id, parsed.data));
}));
router.get("/creatives/:id", requireCreativeAccess, asyncHandler(async (req, res) => {
  const creative = await getCreative(req.params.id);
  if (!creative) return res.status(404).json({ error: "Not found" });
  res.json(creative);
}));
router.delete("/creatives/:id", requireCreativeAccess, asyncHandler(async (req, res) => {
  const deleted = await deleteCreative(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
}));
router.post("/creatives/variations", asyncHandler(async (req, res) => {
  const parsed = z.object({ headline: z.string(), body: z.string(), callToAction: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try { res.json(await generateCreativeVariations(parsed.data)); }
  catch (err) { sendError(res, err, 502, "Variation generation failed"); }
}));

// Campaigns — handled inline in this gateway
/**
 * Create a campaign from a strategy.
 *
 * Previously this wrote straight to Prisma with `businessId: req.body.businessId` — a field the
 * client has never sent (see api/client.ts createCampaign, which posts only strategyId/name/
 * dailyBudgetCents). businessId is a required column, so EVERY "New campaign" click 500'd with
 * `Argument 'businessId' is missing`. It also stored the raw request body as the campaign's `data`,
 * which would have produced a campaign with no id, status, networks or variants even had it saved.
 *
 * Now it goes through buildCampaignFromStrategy, the same builder the generation flow uses: it
 * resolves the business (and its workspace) FROM THE STRATEGY rather than trusting the caller,
 * builds real variants, verifies landing URLs, and allocates the C-000N reference.
 *
 * requireStrategyAccess is the authorization: ownership is derived from the strategy the caller
 * names. The old route had no check at all and took workspaceId from the body, so any authenticated
 * user could plant a campaign in any tenant simply by naming their workspace.
 */
router.post("/campaigns", requireStrategyAccessFromBody, asyncHandler(async (req: AuthedRequest, res) => {
  const { strategyId, name, dailyBudgetCents, objective } = req.body ?? {};
  if (typeof strategyId !== "string" || !strategyId) return res.status(400).json({ error: "strategyId is required" });
  const budget = Number(dailyBudgetCents);
  if (!Number.isFinite(budget) || budget <= 0) return res.status(400).json({ error: "dailyBudgetCents (positive number) is required" });
  const campaign = await buildCampaignFromStrategy(
    strategyId,
    typeof name === "string" && name.trim() ? name.trim() : "Untitled campaign",
    Math.round(budget),
    typeof objective === "string" ? objective : undefined
  );
  res.json(campaign);
}));
router.get("/businesses/:id/campaigns", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => {
  const campaigns = await prisma.campaign.findMany({ where: { businessId: req.params.id } });
  res.json(campaigns.map(c => ({ id: c.id, ...c.data as object })));
}));
// Static /campaigns/* routes MUST be declared before the /campaigns/:id param route below,
// or Express matches them as an :id. Objective picker + budget simulator for the generation flow.
router.get("/campaigns/objectives", asyncHandler(async (_req, res) => res.json({ objectives: listObjectives() })));
router.post("/campaigns/simulate", asyncHandler(async (req, res) => {
  const dailyBudgetCents = Number(req.body?.dailyBudgetCents);
  if (!Number.isFinite(dailyBudgetCents) || dailyBudgetCents <= 0) {
    return res.status(400).json({ error: "dailyBudgetCents (positive number) is required" });
  }
  res.json(simulateBudget({ objective: req.body?.objective, dailyBudgetCents, platforms: req.body?.platforms, countries: req.body?.countries, currency: req.body?.currency }));
}));
/**
 * What a budget will actually buy, for the campaign builder's live readiness panel.
 *
 * Distinct from /campaigns/simulate: that one projects impressions and clicks. This one answers the
 * questions that decide whether a campaign can work at all — how many ad sets the budget can fund
 * without starving them, which conversion event it can feed ~50 of per week, and what a lead is
 * likely to cost. Previously all of that was computed once at generation time and never again, so
 * a user could halve the budget in the builder and see nothing change.
 *
 * Stateless (nothing is saved) so it can be called on every keystroke, but the CURRENCY is resolved
 * server-side from the connected ad account rather than taken from the body — it drives Meta's
 * per-currency minimums, and a wrong one silently produces a projection for the wrong market.
 */
router.post("/campaigns/projection", asyncHandler(async (req: AuthedRequest, res) => {
  const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : undefined;
  if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
  if (req.userId && !(await getMembership(workspaceId, req.userId))) {
    return res.status(403).json({ error: "You do not have access to this workspace" });
  }
  const dailyBudgetCents = Number(req.body?.dailyBudgetCents);
  if (!Number.isFinite(dailyBudgetCents) || dailyBudgetCents <= 0) {
    return res.status(400).json({ error: "dailyBudgetCents (positive number) is required" });
  }
  const currency = (await getMetaCredentials(workspaceId).catch(() => null))?.currency;
  const audiences = Math.max(1, Number(req.body?.audiences) || 1);
  const platforms = Array.isArray(req.body?.platforms)
    ? req.body.platforms.filter((p: unknown): p is "meta" | "google" => p === "meta" || p === "google")
    : undefined;
  const targetCpaCents = Number(req.body?.targetCpaCents) > 0 ? Number(req.body.targetCpaCents) : undefined;
  res.json(
    buildFeasibilityProjection(dailyBudgetCents, audiences, {
      objective: req.body?.objective,
      platforms,
      countries: Array.isArray(req.body?.countries) ? req.body.countries : undefined,
      currency,
      targetCpaCents,
    })
  );
}));
// Guarded for the same reason as the PATCH below: a campaign's `data` carries its full strategy, ad
// copy, budgets and landing URLs, so an unguarded read is cross-tenant data exposure.
router.get("/campaigns/:id", requireCampaignAccess, asyncHandler(async (req, res) => {
  const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  res.json({ id: campaign.id, ...campaign.data as object });
}));
// requireCampaignAccess, matching every other campaign route. Without it ANY authenticated user could
// PATCH ANY campaign in any workspace — and this route shallow-merges req.body straight into the
// campaign's data, so that included dailyBudgetCents, landingPageUrl and variants: cross-tenant
// tampering with what gets published and how much it spends. Its neighbours (DELETE, launch, pause,
// activate, ad-sets) were all guarded; these two were simply missed.
router.patch("/campaigns/:id", requireCampaignAccess, asyncHandler(async (req, res) => {
  const existing = await prisma.campaign.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Campaign not found" });
  const updated = await prisma.campaign.update({ where: { id: req.params.id }, data: { data: { ...(existing.data as object), ...req.body } } });
  res.json({ id: updated.id, ...updated.data as object });
}));
router.delete("/campaigns/:id", requireCampaignAccess, asyncHandler(async (req, res) => {
  try {
    const deleted = await deleteCampaign(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Campaign not found" });
    res.json({ ok: true });
  } catch (err) {
    // A launched campaign can't be deleted (its live/paused Meta/Google objects would be orphaned).
    if (err instanceof CampaignLaunchedDeleteError) return res.status(409).json({ error: err.message, code: "CAMPAIGN_LAUNCHED" });
    throw err;
  }
}));
// The mutating campaign routes below (launch/activate/pause/budget) can spend real money, so each
// takes TWO ownership checks: requireCampaignAccess (can this user touch this campaign?) as route
// middleware, plus this inline guard that the body-supplied workspaceId — which selects WHOSE Meta/
// Google credentials get charged — is one the caller actually belongs to. Without the second check,
// an authenticated user could pass another tenant's workspaceId and launch against their ad account.
async function resolveSpendWorkspace(
  req: AuthedRequest,
  campaign: { workspaceId: string | null; businessId: string }
): Promise<{ ok: true; workspaceId: string } | { ok: false; status: number; error: string }> {
  // Default to the campaign's own workspace (set at a prior launch) or its business's workspace,
  // rather than a hardcoded "demo-workspace" that would resolve some unrelated tenant's credentials.
  let fallbackWorkspace = campaign.workspaceId;
  if (!fallbackWorkspace) {
    const business = await prisma.business.findUnique({ where: { id: campaign.businessId }, select: { workspaceId: true } });
    fallbackWorkspace = business?.workspaceId ?? null;
  }
  const requested = typeof req.body?.workspaceId === "string" && req.body.workspaceId.length > 0 ? req.body.workspaceId : undefined;
  const workspaceId = requested ?? fallbackWorkspace;
  if (!workspaceId) {
    return { ok: false, status: 400, error: "This campaign is not assigned to a workspace; pass an explicit workspaceId you belong to." };
  }
  // requireCampaignAccess already proved membership of the campaign's own workspace; only a
  // DIFFERENT, caller-supplied workspaceId needs its own membership check here.
  if (workspaceId !== campaign.workspaceId && req.userId && !(await getMembership(workspaceId, req.userId))) {
    return { ok: false, status: 403, error: "You do not have access to the requested workspace" };
  }
  return { ok: true, workspaceId };
}

router.post("/campaigns/:id/launch", requireCampaignAccess, asyncHandler(async (req: AuthedRequest, res) => {
  const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  const resolved = await resolveSpendWorkspace(req, campaign);
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  const workspaceId = resolved.workspaceId;
  const data = campaign.data as any;
  const hasMetaVariants = (data.variants ?? []).some((v: any) => v.network === "meta");
  if (hasMetaVariants) {
    const metaCreds = await getMetaCredentials(workspaceId);
    if (!metaCreds) {
      return res.status(422).json({ error: "No Meta ad account connected. Connect your Meta Business account in Settings before launching.", code: "META_NOT_CONNECTED" });
    }
    // A Meta ad requires a Page (object_story_spec.page_id) — without one, createHierarchyAd fails
    // deep in the per-variant loop after the campaign container + ad set already exist. Catch it at
    // the pre-flight gate so the user gets an actionable message instead of a half-built graph.
    const effectivePageId = data.pageId ?? metaCreds.pageId;
    if (!effectivePageId) {
      return res.status(422).json({ error: "No Facebook Page connected. A Page is required to publish Meta ads — reconnect your Meta account and grant Page access.", code: "META_PAGE_MISSING" });
    }
    // Can the account actually pay? Every other foreseeable publish failure is corrected or guarded
    // before this point, so funding is the one class left that no amount of fixing on our side can
    // resolve. Checking it here means the user is told to top up BEFORE a campaign container exists
    // rather than after four ad sets have failed. Fails open by design (see checkAdAccountCanSpend).
    const spend = await checkAdAccountCanSpend(workspaceId);
    if (!spend.ok) {
      // 402 Payment Required: distinct from a 422 misconfiguration, so the UI can offer the
      // billing link rather than send the user hunting through settings.
      return res.status(402).json({ error: spend.reason, code: spend.code, billingUrl: spend.billingUrl });
    }
  }
  // Symmetric pre-flight for Google — without this, a Google variant with no connection would
  // silently fail inside launchGoogleHierarchy (variant marked "failed") instead of prompting
  // the user to connect. Mirrors the Meta check above.
  const hasGoogleVariants = (data.variants ?? []).some((v: any) => v.network === "google");
  if (hasGoogleVariants) {
    const googleCreds = await getGoogleAdsCredentials(workspaceId);
    if (!googleCreds) {
      return res.status(422).json({ error: "No Google Ads account connected. Connect your Google Ads account in Settings before launching.", code: "GOOGLE_NOT_CONNECTED" });
    }
  }
  try {
    const launched = await launchCampaign(req.params.id, workspaceId);
    res.json(launched);
  } catch (err: any) {
    if (err.message?.includes("not found")) return res.status(404).json({ error: err.message });
    if (err.message?.includes("already launching")) return res.status(409).json({ error: err.message, code: "LAUNCH_IN_PROGRESS" });
    // A funding rejection that slipped past the pre-flight above (Meta gates some billing fields,
    // so the check fails open) still reaches the user as a payment problem, not a generic 500.
    if (err instanceof MetaGraphError && err.isPaymentError) {
      return res.status(402).json({ error: err.userMessage ?? err.message, code: "PAYMENT" });
    }
    res.status(500).json({ error: err.message ?? "Campaign launch failed" });
  }
}));
router.post("/campaigns/:id/variants/:variantId/pause", requireCampaignAccess, asyncHandler(async (req, res) => {
  try {
    const result = await pauseVariant(req.params.id, req.params.variantId);
    res.json(result);
  } catch (err: any) {
    const status = err.message?.includes("not found") || err.message?.includes("not launched") ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
}));
router.post("/campaigns/:id/variants/:variantId/activate", requireCampaignAccess, asyncHandler(async (req, res) => {
  try {
    const result = await activateVariant(req.params.id, req.params.variantId);
    res.json(result);
  } catch (err: any) {
    const status = err.message?.includes("not found") || err.message?.includes("not launched") ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
}));
router.post("/campaigns/:id/apply-creative-media", requireCampaignAccess, asyncHandler(async (req, res) => {
  try {
    const result = await applyCreativeMedia(req.params.id, req.body);
    res.json(result);
  } catch (err: any) {
    if (err.message?.includes("not found")) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
}));
router.post("/campaigns/:id/variants/:variantId/budget", requireCampaignAccess, asyncHandler(async (req, res) => {
  const dailyBudgetCents = Number(req.body.dailyBudgetCents);
  if (!dailyBudgetCents || dailyBudgetCents <= 0 || dailyBudgetCents > MAX_BUDGET_CENTS) {
    return res.status(400).json({ error: "Invalid budget amount" });
  }
  try {
    const result = await reallocateBudget(req.params.id, req.params.variantId, dailyBudgetCents);
    res.json(result);
  } catch (err: any) {
    const status = err.message?.includes("not found") || err.message?.includes("not launched") ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
}));
// ── requireCampaignAccess on the five routes below ────────────────────────────────────────────
// These were the only /campaigns/:id routes without it, and that cost two things at once.
//
// Correctness: the middleware is also what rewrites a slug to the real UUID
// (resolveCampaignSlugParam), so these five were the only campaign routes that still needed a raw
// id. Since every in-app link is a slug now, opening a campaign page surfaced
// "Campaign c-0011-polluxa-sales-2026-08-01 not found" from whichever of them ran first.
//
// Security: ingest / optimize / auto-optimize MUTATE a campaign, and none of them checked
// ownership at all — any authenticated user could drive them against another tenant's campaign by
// id. That is the same bare-id hole resourceOwnership.ts exists to close, just never wired here.
router.post("/campaigns/:id/ingest", requireCampaignAccess, asyncHandler(async (req, res) => {
  // On-demand metrics pull so the UI can populate a just-launched campaign immediately
  // instead of waiting for the next 15-min metrics-ingestion worker tick.
  try {
    const metrics = await ingestCampaignMetrics(req.params.id);
    res.json({ ok: true, ingested: metrics.length });
  } catch (err: any) {
    if (err.message?.includes("not found")) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message ?? "Metrics ingestion failed" });
  }
}));
router.get("/campaigns/:id/performance", requireCampaignAccess, asyncHandler(async (req, res) => {
  const snapshots = await prisma.campaignPerformanceSnapshot.findMany({ where: { campaignId: req.params.id }, orderBy: { capturedAt: "desc" }, take: 30 });
  res.json(snapshots);
}));
router.get("/campaigns/:id/live-insights", requireCampaignAccess, asyncHandler(async (req, res) => {
  const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  const data = campaign.data as any;
  const variants: any[] = data.variants ?? [];
  const liveVariants = variants.filter((v: any) => v.externalId && (v.status === "active" || v.status === "paused"));

  const emptyFunnel = { addToCart: 0, addPaymentInfo: 0, purchases: 0, purchaseValueCents: 0 };
  if (liveVariants.length === 0) {
    return res.json({ campaignId: req.params.id, isLive: false, impressions: 0, reach: 0, clicks: 0, conversions: 0, spendCents: 0, revenueCents: 0, ctr: 0, cpcCents: null, cpmCents: null, roas: null, funnel: emptyFunnel, costPerAddToCartCents: null, costPerAddPaymentInfoCents: null, costPerPurchaseCents: null, addToCartRate: null, purchaseRate: null, byNetwork: {} });
  }

  const workspaceId = data.workspaceId ?? campaign.workspaceId ?? "demo-workspace";
  // Resolve each network's credentials once (not per-variant) — a campaign can hold both Meta and
  // Google variants, and each adapter needs its own account creds.
  const metaCredentials = (await getMetaCredentials(workspaceId)) ?? undefined;
  const googleCredentials = (await getGoogleAdsCredentials(workspaceId)) ?? undefined;
  // Optional date_preset from the Ads Manager range picker (last_7d/last_14d/…); falls back to
  // today's date, which the adapters treat as "no preset → default window".
  const datePreset = typeof req.query.range === "string" && req.query.range ? req.query.range : new Date().toISOString().slice(0, 10);

  // Accumulate metrics PER NETWORK so a dual-network campaign can be split into a Meta slice and a
  // Google slice in the Ads Manager (one row per campaign×network) — the counts come genuinely
  // per-variant from each ad network, so this split is accurate, not an estimate.
  type NetAccum = { impressions: number; reach: number; clicks: number; conversions: number; spendCents: number; revenueCents: number; liveVariantCount: number; funnel: { addToCart: number; addPaymentInfo: number; purchases: number; purchaseValueCents: number } };
  const newAccum = (): NetAccum => ({ impressions: 0, reach: 0, clicks: 0, conversions: 0, spendCents: 0, revenueCents: 0, liveVariantCount: 0, funnel: { addToCart: 0, addPaymentInfo: 0, purchases: 0, purchaseValueCents: 0 } });
  const perNetwork: Record<string, NetAccum> = {};

  for (const v of liveVariants) {
    const net = v.network === "google" ? "google" : "meta";
    const acc = (perNetwork[net] ??= newAccum());
    acc.liveVariantCount++;
    try {
      // Route each variant to its own network's adapter — a Google variant queried via the Meta
      // adapter (the old hardcoded behavior) returned nothing, so the Google tab showed no data.
      const stats = net === "google"
        ? await googleAdapter.fetchInsights(v.externalId, datePreset, googleCredentials)
        : await metaAdapter.fetchInsights(v.externalId, datePreset, metaCredentials);
      acc.impressions += stats.impressions;
      acc.reach += stats.reach;
      acc.clicks += stats.clicks;
      acc.conversions += stats.conversions;
      acc.spendCents += stats.spendCents;
      acc.revenueCents += stats.revenueCents ?? 0;
      if (stats.funnel) {
        acc.funnel.addToCart += stats.funnel.addToCart;
        acc.funnel.addPaymentInfo += stats.funnel.addPaymentInfo;
        acc.funnel.purchases += stats.funnel.purchases;
        acc.funnel.purchaseValueCents += stats.funnel.purchaseValueCents;
      }
    } catch { /* variant may have been deleted on the ad network */ }
  }

  // Split the campaign's single daily budget across networks proportionally to each network's live
  // variant count, so the per-network rows' budgets sum back to the campaign total (no double-count).
  const totalLiveVariants = liveVariants.length || 1;
  const buildSlice = (acc: NetAccum) => {
    const { liveVariantCount, funnel, ...m } = acc;
    return {
      ...m,
      funnel,
      dailyBudgetCents: 0, // set by the caller after proportional split
      ctr: m.impressions > 0 ? m.clicks / m.impressions : 0,
      cpcCents: m.clicks > 0 ? Math.round(m.spendCents / m.clicks) : null,
      cpmCents: m.impressions > 0 ? Math.round((m.spendCents / m.impressions) * 1000) : null,
      roas: m.spendCents > 0 && m.revenueCents > 0 ? m.revenueCents / m.spendCents : null,
      costPerAddToCartCents: funnel.addToCart > 0 ? Math.round(m.spendCents / funnel.addToCart) : null,
      costPerAddPaymentInfoCents: funnel.addPaymentInfo > 0 ? Math.round(m.spendCents / funnel.addPaymentInfo) : null,
      costPerPurchaseCents: funnel.purchases > 0 ? Math.round(m.spendCents / funnel.purchases) : null,
      addToCartRate: m.clicks > 0 ? funnel.addToCart / m.clicks : null,
      purchaseRate: m.clicks > 0 ? funnel.purchases / m.clicks : null,
      liveVariantCount,
    };
  };
  const campaignDailyBudgetCents = Number((data.dailyBudgetCents ?? 0));
  const byNetwork: Record<string, any> = {};
  for (const [net, acc] of Object.entries(perNetwork)) {
    const slice = buildSlice(acc);
    slice.dailyBudgetCents = Math.round(campaignDailyBudgetCents * (acc.liveVariantCount / totalLiveVariants));
    byNetwork[net] = slice;
  }

  // Campaign-wide aggregate (unchanged shape) — sum across networks for the "all" / dual-network view.
  const agg = Object.values(perNetwork).reduce((a, acc) => {
    a.impressions += acc.impressions; a.reach += acc.reach; a.clicks += acc.clicks;
    a.conversions += acc.conversions; a.spendCents += acc.spendCents; a.revenueCents += acc.revenueCents;
    a.funnel.addToCart += acc.funnel.addToCart; a.funnel.addPaymentInfo += acc.funnel.addPaymentInfo;
    a.funnel.purchases += acc.funnel.purchases; a.funnel.purchaseValueCents += acc.funnel.purchaseValueCents;
    return a;
  }, newAccum());
  const { funnel } = agg;

  res.json({
    campaignId: req.params.id,
    isLive: true,
    impressions: agg.impressions,
    reach: agg.reach,
    clicks: agg.clicks,
    conversions: agg.conversions,
    spendCents: agg.spendCents,
    revenueCents: agg.revenueCents,
    ctr: agg.impressions > 0 ? agg.clicks / agg.impressions : 0,
    cpcCents: agg.clicks > 0 ? Math.round(agg.spendCents / agg.clicks) : null,
    cpmCents: agg.impressions > 0 ? Math.round((agg.spendCents / agg.impressions) * 1000) : null,
    // True ROAS: real reported revenue / spend.
    roas: agg.spendCents > 0 && agg.revenueCents > 0 ? agg.revenueCents / agg.spendCents : null,
    funnel,
    // Cost-per-step: total spend divided by that step's count. Null (not 0) when the step has no
    // events, so the UI shows "—" rather than an infinite/meaningless cost.
    costPerAddToCartCents: funnel.addToCart > 0 ? Math.round(agg.spendCents / funnel.addToCart) : null,
    costPerAddPaymentInfoCents: funnel.addPaymentInfo > 0 ? Math.round(agg.spendCents / funnel.addPaymentInfo) : null,
    costPerPurchaseCents: funnel.purchases > 0 ? Math.round(agg.spendCents / funnel.purchases) : null,
    // Step CVR relative to clicks (top of the paid funnel). Null when there are no clicks.
    addToCartRate: agg.clicks > 0 ? funnel.addToCart / agg.clicks : null,
    purchaseRate: agg.clicks > 0 ? funnel.purchases / agg.clicks : null,
    // Per-network slices so the Ads Manager can render one row per campaign×network.
    byNetwork,
  });
}));
router.get("/campaigns/:id/trend", requireCampaignAccess, asyncHandler(async (req, res) => res.json(await getCampaignTrend(req.params.id))));
router.post("/campaigns/:id/optimize", requireCampaignAccess, asyncHandler(async (req, res) => {
  // Manual "optimize now" — runs the same optimization pass the metrics worker runs on a
  // schedule, and persists the resulting decisions to the workspace's AI-insights feed.
  const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  try {
    const decisions = await runOptimizationPass(req.params.id);
    const workspaceId = (campaign.data as any)?.workspaceId ?? campaign.workspaceId;
    if (workspaceId && decisions.length) await recordOptimizationInsights(workspaceId, decisions);
    res.json({ ok: true, decisions });
  } catch (err: any) {
    if (err.message?.includes("not found")) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message ?? "Optimization failed" });
  }
}));
// Persistent 24/7 auto-optimize toggle. Stored on the campaign's data blob (no schema column);
// the scheduled metrics-ingestion worker reads this flag and skips the optimization pass when
// it's explicitly false, so the user can turn autonomous budget/pause moves off per campaign.
router.post("/campaigns/:id/auto-optimize", requireCampaignAccess, asyncHandler(async (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) is required" });
  const existing = await prisma.campaign.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Campaign not found" });
  const updated = await prisma.campaign.update({
    where: { id: req.params.id },
    data: { data: { ...(existing.data as object), autoOptimize: enabled } },
  });
  res.json({ id: updated.id, autoOptimize: enabled });
}));

// Billing — handled inline in this gateway
router.post("/businesses/:id/invoices", requireBusinessAccess("params", "id"), asyncHandler(async (_req, res) => res.json([])));
router.get("/businesses/:id/invoices", requireBusinessAccess("params", "id"), asyncHandler(async (req, res) => {
  const invoices = await prisma.invoice.findMany({ where: { businessId: req.params.id } }).catch(() => []);
  res.json(invoices);
}));

// Onboarding
const scrapeSchema = z.object({ url: z.string().min(1) });
router.post("/onboarding/scrape", asyncHandler(async (req, res) => {
  const parsed = scrapeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try { res.json(await scrapeUrl(parsed.data.url)); }
  catch (err) { sendError(res, err, 422, "Failed to scrape URL"); }
}));

const productAnalysisSchema = z.object({
  url: z.string(),
  title: z.string(),
  description: z.string(),
  excerpt: z.string(),
  images: z.array(z.string()).default([]),
  crawledPages: z.array(z.string()).default([]),
  pagesDiscovered: z.number().default(0),
});
router.post("/onboarding/analyze-product", asyncHandler(async (req, res) => {
  const parsed = productAnalysisSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try { res.json(await analyzeProduct(parsed.data)); }
  catch (err) { sendError(res, err, 502, "Product analysis failed"); }
}));

const audienceAnalysisSchema = z.object({
  site: productAnalysisSchema,
  product: z.object({ productName: z.string(), category: z.string(), summary: z.string(), valueProposition: z.string(), keyFeatures: z.array(z.string()) }),
});
router.post("/onboarding/analyze-audience", asyncHandler(async (req, res) => {
  const parsed = audienceAnalysisSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try { res.json(await analyzeAudience(parsed.data.site, parsed.data.product)); }
  catch (err) { sendError(res, err, 502, "Audience analysis failed"); }
}));

const deepResearchSchema = z.object({
  url: z.string().min(1),
  // Optional business context — when both are present the crawl is persisted page-by-page
  // (CrawlJob/CrawlPage/CrawlFact) instead of only returning the in-memory analysis.
  businessId: z.string().optional(),
  workspaceId: z.string().optional(),
});
router.post("/onboarding/deep-research", asyncHandler(async (req, res) => {
  const parsed = deepResearchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try { res.json(await runDeepResearch(parsed.data.url, { businessId: parsed.data.businessId, workspaceId: parsed.data.workspaceId })); }
  catch (err) { sendError(res, err, 422, "Deep research failed"); }
}));

// Deep research sessions — the job/polling replacement for /onboarding/deep-research
// above, needed because the richer web-search-backed pipeline (marketResearch.ts) is
// too slow for one blocking request. A recently-completed session for the same URL is
// cloned instead of re-run unless ?force=true, so resubmitting doesn't re-spend real
// web searches.
const researchSessionSchema = z.object({ url: z.string().min(1), businessId: z.string().optional() });
router.post("/workspaces/:id/research-sessions", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = researchSessionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { url, businessId } = parsed.data;
  const workspaceId = req.params.id;
  const force = req.query.force === "true";

  try {
    if (!force) {
      const cached = await findCachedSession(workspaceId, url);
      if (cached) {
        const cloned = await cloneSessionFromCache(workspaceId, url, cached, businessId);
        return res.status(201).json(cloned);
      }
    }

    const session = await createResearchSession(workspaceId, url, businessId);
    await researchSessionQueue.add("research", { sessionId: session.id, url });
    res.status(202).json(session);
  } catch (err) {
    sendError(res, err, 422, "Failed to start research session");
  }
}));

router.get("/research-sessions/:id", asyncHandler(async (req: AuthedRequest, res) => {
  const session = await getResearchSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Research session not found" });
  if (!(await getMembership(session.workspaceId, req.userId!))) {
    return res.status(403).json({ error: "You do not have access to this research session" });
  }
  res.json(session);
}));

/* ═══════════════════════════════════════════════
   RESEARCH ORCHESTRATOR — Campaign -> Research Orchestrator -> Providers (9, run in
   parallel) -> Knowledge Aggregator -> AI Agents -> Campaign. A separate pipeline from
   the research-sessions block above (ResearchJob, not ResearchSession) rather than a
   replacement of it — see apps/api/src/research for the orchestrator/providers/
   aggregator implementation. `/businesses/:id/strategies/from-research` below accepts
   either a legacy researchSessionId or a researchJobId so the existing "AI Agents" step
   (createStrategyFromResearch) serves both pipelines without a second implementation.
   ═══════════════════════════════════════════════ */

const researchStartSchema = z.object({
  workspaceId: z.string().min(1),
  url: z.string().min(1),
  businessId: z.string().optional(),
});

router.post("/research/start", requireWorkspaceMember("body", "workspaceId"), asyncHandler(async (req, res) => {
  const parsed = researchStartSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { workspaceId, url, businessId } = parsed.data;

  try {
    const job = await createResearchJob(workspaceId, url, businessId);
    await researchOrchestratorQueue.add("research-orchestrate", { jobId: job.id });
    res.status(202).json(job);
  } catch (err) {
    sendError(res, err, 422, "Failed to start research job");
  }
}));

router.get("/research/:id", asyncHandler(async (req: AuthedRequest, res) => {
  const job = await getResearchJobWithExecutions(req.params.id);
  if (!job) return res.status(404).json({ error: "Research job not found" });
  if (!(await getMembership(job.workspaceId, req.userId!))) {
    return res.status(403).json({ error: "You do not have access to this research job" });
  }
  res.json(job);
}));

router.get("/research/:id/status", asyncHandler(async (req: AuthedRequest, res) => {
  const job = await getResearchOrchestratorJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Research job not found" });
  if (!(await getMembership(job.workspaceId, req.userId!))) {
    return res.status(403).json({ error: "You do not have access to this research job" });
  }
  res.json({
    id: job.id,
    status: job.status,
    error: job.error,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
  });
}));

/* ═══════════════════════════════════════════════
   CAMPAIGN GENERATION (Campaign Route) — the full agent-pipeline, wired end to end:
   Gateway -> Campaign Route -> Research Orchestrator -> Knowledge Aggregator -> AI Agent
   Coordinator (10 agents) -> Campaign Builder -> Persist -> Return Response. One POST
   kicks off a single async job (campaignGenerationPipeline.ts, driven by
   workers/campaignGenerationWorker.ts) that supersedes nothing existing — every route
   above keeps working unchanged.
   ═══════════════════════════════════════════════ */

const campaignGenerateSchema = z.object({
  workspaceId: z.string().min(1),
  businessId: z.string().min(1),
  url: z.string().min(1),
  name: z.string().min(1).optional(),
  dailyBudgetCents: z.number().int().positive().max(MAX_BUDGET_CENTS).optional(),
  // Only the ACTIVE_NETWORKS (Meta + Google today) are accepted. TikTok/LinkedIn/etc. are
  // "coming soon" — rejected at the boundary so a channel we can't actually launch can never
  // enter the pipeline. Driven by the central platform catalog (config/platforms.ts) so the
  // accepted set widens automatically when a network graduates.
  channels: z.array(z.enum(ACTIVE_NETWORKS)).optional(),
  // Stop after research + agents + strategy and wait for the Promotion Objective selections
  // before writing any ads (see the pipeline's deferBuild and POST .../build below).
  deferBuild: z.boolean().optional(),
  objective: z.string().optional(),
  countries: z.array(z.string()).optional(),
  // Bypass the research cache and force a fresh 27-provider run for this generation.
  forceRefresh: z.boolean().optional(),
  // When set, generation is gated on this pixel being confirmed LIVE (available + firing recent
  // events) — the server re-runs the same confirmPixelLive check the UI gate uses, so a campaign
  // can't be generated pointing at a dead/uninstalled pixel even if the UI check is bypassed.
  pixelId: z.string().min(1).optional(),
});

router.post("/campaigns/generate", requireWorkspaceMember("body", "workspaceId"), asyncHandler(async (req, res) => {
  const parsed = campaignGenerateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { workspaceId, businessId, url, name, dailyBudgetCents, objective, forceRefresh, pixelId, channels, countries, deferBuild } = parsed.data;
  // Only forward a valid post-ODAX Meta objective to the pipeline; anything else is dropped so
  // launchMetaHierarchy falls back to its default rather than sending junk to the Graph API.
  const validObjective = objective && isValidObjective(objective) ? objective : undefined;

  const business = await getBusiness(businessId);
  if (!business) return res.status(404).json({ error: "Business not found" });
  if (business.workspaceId !== workspaceId) {
    return res.status(403).json({ error: "This business does not belong to the given workspace" });
  }

  // Live pixel gate: if a pixel was selected for this generation, it must be confirmed live
  // (available + firing recent events) before we spend the pipeline's LLM budget and, eventually,
  // ad budget on it. Mirrors the UI's confirm gate so bypassing the UI can't skip the check.
  if (pixelId) {
    let confirmation;
    try {
      confirmation = await confirmPixelLive(workspaceId, pixelId);
    } catch (err) {
      return sendError(res, err, 502, "Failed to confirm Meta pixel status before generation");
    }
    if (!confirmation.live) {
      return res.status(409).json({ error: `Pixel ${pixelId} is not confirmed live — ${confirmation.reason}`, pixelConfirmation: confirmation });
    }
  }

  // Return a recent completed job for the same (workspace, business, url) if one exists
  // and forceRefresh isn't requested — avoids re-running the full pipeline when verified
  // data is already available. Normalizes URL variants (with/without https://) to match.
  if (!forceRefresh) {
    const normalizedUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const bareHost = normalizedUrl.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    const urlVariants = [url, normalizedUrl, `https://${bareHost}`, `http://${bareHost}`, bareHost];
    // Pull the recent completed candidates (bounded), keep only those still FRESH within the TTL,
    // then reuse the HIGHEST-CONFIDENCE one — not merely the most recent. Confidence lives inside
    // the decisionContext JSON (no column to orderBy), so ranking happens here in code. This is
    // what makes "show the best data we have, and only if it's fresh" actually hold: previously it
    // returned newest-within-14-days regardless of confidence, surfacing stale low-confidence runs.
    const candidates = await prisma.campaignGenerationJob.findMany({
      where: { workspaceId, businessId, url: { in: urlVariants }, status: "completed", decisionContext: { not: null as any } },
      orderBy: { completedAt: "desc" },
      take: 20,
    });
    const ttl = CAMPAIGN_RESEARCH_FRESHNESS_TTL_MS;
    const confidenceOf = (dc: unknown): number => {
      const c = (dc as { confidence?: unknown } | null)?.confidence;
      return typeof c === "number" ? c : 0;
    };
    const fresh = candidates.filter((c) => {
      const researchedAt = c.completedAt ?? c.startedAt ?? c.createdAt;
      return !isStale(researchedAt.toISOString(), ttl);
    });
    const existing = fresh.sort((a, b) => confidenceOf(b.decisionContext) - confidenceOf(a.decisionContext))[0];
    if (existing) {
      return res.status(200).json({
        id: existing.id,
        workspaceId: existing.workspaceId,
        businessId: existing.businessId,
        url: existing.url,
        status: existing.status,
        researchJobId: existing.researchJobId,
        strategyId: existing.strategyId,
        campaignId: existing.campaignId,
        decisionContext: existing.decisionContext,
        agentResults: existing.agentResults,
        error: existing.error,
        startedAt: existing.startedAt?.toISOString(),
        completedAt: existing.completedAt?.toISOString(),
        createdAt: existing.createdAt.toISOString(),
        updatedAt: existing.updatedAt.toISOString(),
      });
    }
  }

  try {
    const job = await createCampaignGenerationJob({ workspaceId, businessId, url, name, dailyBudgetCents });
    await campaignGenerationQueue.add("campaign-generate", { jobId: job.id, forceRefresh: forceRefresh ?? false, objective: validObjective, channels, countries, deferBuild: deferBuild ?? false });
    res.status(202).json(job);
  } catch (err) {
    sendError(res, err, 422, "Failed to start campaign generation");
  }
}));

router.get("/campaigns/generate/:id", asyncHandler(async (req: AuthedRequest, res) => {
  const job = await getCampaignGenerationJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Campaign generation job not found" });
  if (!(await getMembership(job.workspaceId, req.userId!))) {
    return res.status(403).json({ error: "You do not have access to this campaign generation job" });
  }
  res.json(job);
}));

// How long a completed generation's research is considered fresh before a new generate request
// re-runs the pipeline instead of reusing the cached job. Reuses the same freshnessScore/isStale
// math Research Memory's retrieval applies (research/knowledge/freshness.ts). Kept deliberately
// short (5h) — a business's own market/competitor/pricing read goes stale fast, and reusing a
// day-old cached run is exactly what surfaced 2-day-old low-confidence data in the UI.
const CAMPAIGN_RESEARCH_FRESHNESS_TTL_MS = 5 * 60 * 60 * 1000;

router.get("/campaigns/generate/:id/status", asyncHandler(async (req: AuthedRequest, res) => {
  const job = await getCampaignGenerationJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Campaign generation job not found" });
  if (!(await getMembership(job.workspaceId, req.userId!))) {
    return res.status(403).json({ error: "You do not have access to this campaign generation job" });
  }
  const researchedAt = job.completedAt ?? job.startedAt ?? job.createdAt;
  res.json({
    id: job.id,
    status: job.status,
    researchJobId: job.researchJobId,
    strategyId: job.strategyId,
    campaignId: job.campaignId,
    decisionContext: job.decisionContext,
    // The 20-agent pipeline's raw per-agent output (Record<agentName, AgentResult<unknown>>) —
    // already computed and persisted, previously never returned to any caller. Exposed here so
    // the UI can show which data sources actually grounded each agent's recommendation and flag
    // any that had to fall back to a generic guess, instead of only showing decisionContext's
    // separate ranked-recommendation view.
    agentResults: job.agentResults,
    error: job.error,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
    url: job.url,
    // Freshness of the underlying research, for a "Researched N days ago" UI badge — computed
    // the same way Research Memory scores its own retrieved entries' age (see freshness.ts),
    // just against this job's own completion time rather than a memory row's createdAt.
    researchedAt,
    researchFreshness: freshnessScore(researchedAt, CAMPAIGN_RESEARCH_FRESHNESS_TTL_MS),
    researchIsStale: isStale(researchedAt, CAMPAIGN_RESEARCH_FRESHNESS_TTL_MS),
  });
}));

router.get("/campaigns/generate/:id/progress", asyncHandler(async (req: AuthedRequest, res) => {
  const job = await getCampaignGenerationJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Campaign generation job not found" });
  if (!(await getMembership(job.workspaceId, req.userId!))) {
    return res.status(403).json({ error: "You do not have access to this campaign generation job" });
  }
  const completedSteps = await getProgressSteps("campaign-generation", job.id);
  res.json({ completedSteps, total: TOTAL_PIPELINE_UNITS });
}));

// Provider.name (e.g. "social-media", "legal-regulatory") -> the ResearchContext field name
// an AgentEvidenceItem.source actually uses (e.g. "socialMedia", "legalRegulatory") — the two
// diverged because providers were named for their own module/file (kebab-case) well before
// the 20-agent layer's evidence trail existed. Keyed here (not in the frontend) so the UI can
// do a direct evidence.source -> citations lookup with no mapping logic of its own. "search"
// (SearchProvider) is deliberately omitted — its output feeds metadata.generalSearch, already
// surfaced under evidence source "general-search" by CampaignAgent, not a ResearchContext field.
const PROVIDER_NAME_TO_CONTEXT_FIELD: Record<string, string> = {
  competitor: "competitors",
  seo: "keywords",
  "social-media": "socialMedia",
  "hiring-signals": "hiringSignals",
  "content-marketing": "contentMarketing",
  "backlink-authority": "backlinkAuthority",
  "app-store": "appStore",
  "video-presence": "videoPresence",
  "local-presence": "localPresence",
  "legal-regulatory": "legalRegulatory",
  "search-ranking": "searchRanking",
  "ad-library": "adLibrary",
  "serp-features": "serpFeatures",
  reddit: "communityDiscussion",
};

// Real citation URLs behind the research, keyed by the same field names the Agent Reasoning
// panel's evidence already uses — resolves job -> ResearchJob (via researchJobId) ->
// ProviderExecution rows, so that panel can show actual clickable sources instead of just
// each field's generic dataSource label.
router.get("/campaigns/generate/:id/citations", asyncHandler(async (req: AuthedRequest, res) => {
  const job = await getCampaignGenerationJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Campaign generation job not found" });
  if (!(await getMembership(job.workspaceId, req.userId!))) {
    return res.status(403).json({ error: "You do not have access to this campaign generation job" });
  }
  if (!job.researchJobId) return res.json({ citationsByField: {}, siteMap: null, competitorAds: null });

  const executions = await prisma.providerExecution.findMany({
    where: { researchJobId: job.researchJobId },
    orderBy: { createdAt: "desc" },
  });
  const citationsByField: Record<string, { url: string; title: string }[]> = {};
  let siteMap: unknown = null;
  let competitorAds: unknown = null;
  for (const e of executions) {
    const field = PROVIDER_NAME_TO_CONTEXT_FIELD[e.provider] ?? e.provider;
    if (!citationsByField[field]) {
      // rows are ordered newest-first — keep only the latest attempt per provider
      const citations = Array.isArray(e.citations) ? (e.citations as { url: string; title: string }[]) : [];
      if (citations.length > 0) citationsByField[field] = citations;
    }
    // The Agent Reasoning panel's Site map / Competitor ads cards need each provider's actual
    // structured output (page list / ad list), not just its citations — pulled straight from
    // ProviderExecution.data since NavigationProvider/AdLibraryProvider aren't wired into any
    // agent's evidence trail (navigation) or need more than the citation label (ad library).
    if (e.provider === "navigation" && siteMap === null) siteMap = e.data;
    if (e.provider === "ad-library" && competitorAds === null) competitorAds = e.data;
  }
  res.json({ citationsByField, siteMap, competitorAds });
}));

// The verified facts behind a generation — what the fact-grounded agents actually saw.
// Resolved job -> CrawlJob (via researchJobId) -> CrawlFact rows with their source pages,
// so the UI can show "this campaign is grounded in N facts from your website" with links.
router.get("/campaigns/generate/:id/facts", asyncHandler(async (req: AuthedRequest, res) => {
  const job = await getCampaignGenerationJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Campaign generation job not found" });
  if (!(await getMembership(job.workspaceId, req.userId!))) {
    return res.status(403).json({ error: "You do not have access to this campaign generation job" });
  }
  if (!job.researchJobId) return res.json({ crawl: null, facts: [] });

  const crawlJob = await prisma.crawlJob.findFirst({ where: { researchJobId: job.researchJobId } });
  if (!crawlJob) return res.json({ crawl: null, facts: [] });

  const facts = await prisma.crawlFact.findMany({
    where: { crawlJobId: crawlJob.id },
    orderBy: { confidence: "desc" },
    include: { crawlPage: { select: { url: true, pageType: true, title: true } } },
  });
  res.json({
    crawl: { url: crawlJob.url, pagesDiscovered: crawlJob.pagesDiscovered, pagesCrawled: crawlJob.pagesCrawled },
    facts: facts.map((f) => ({
      field: f.field,
      value: f.value,
      confidence: f.confidence,
      sourceUrl: f.crawlPage?.url ?? null,
      sourcePageType: f.crawlPage?.pageType ?? null,
      sourcePageTitle: f.crawlPage?.title ?? null,
    })),
  });
}));

// The 6 ranked campaign packages the Campaign Recommendation Engine assembled (research/
// campaign-recommendation/CampaignRecommendationEngine.ts) — same inline ownership check as
// this route's /citations and /facts siblings above, for consistency within this route family.
router.get("/campaigns/generate/:id/recommendations", asyncHandler(async (req: AuthedRequest, res) => {
  const job = await getCampaignGenerationJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Campaign generation job not found" });
  if (!(await getMembership(job.workspaceId, req.userId!))) {
    return res.status(403).json({ error: "You do not have access to this campaign generation job" });
  }
  res.json(await getCampaignRecommendations(job.id));
}));

// Materialize ONE of a job's 3 candidate strategies (Strategy A/B/C) into an editable draft
// Campaign — powers the results page's "pick one of 3 complete campaign suggestions" flow.
// Selecting the winning strategy returns the campaign the pipeline already built (no duplicate);
// selecting another builds a fresh draft on demand from data already computed (no re-research).
/**
 * Finish a DEFERRED generation: write the ads using the Promotion Objective selections.
 *
 * Pairs with `deferBuild` on POST /campaigns/generate. Research, agents and the strategy have
 * already run; this is where the user's objective/budget/platforms/locations finally decide what
 * gets built — which is the whole point of deferring, since previously the ads existed before
 * anyone was asked.
 *
 * Idempotent (see finishCampaignGenerationBuild): a job that already has a campaign returns it
 * rather than building a second one.
 */
router.post("/campaigns/generate/:id/build", asyncHandler(async (req: AuthedRequest, res) => {
  const job = await getCampaignGenerationJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Campaign generation job not found" });
  if (!(await getMembership(job.workspaceId, req.userId!))) {
    return res.status(403).json({ error: "You do not have access to this campaign generation job" });
  }
  const parsed = z
    .object({
      objective: z.string().optional(),
      dailyBudgetCents: z.number().int().positive().max(MAX_BUDGET_CENTS).optional(),
      channels: z.array(z.enum(ACTIVE_NETWORKS)).optional(),
      countries: z.array(z.string()).optional(),
      conversionEvent: z.string().optional(),
      // Both were collected by the Promotion Objective card and dropped before reaching the build:
      // businessType picks the default conversion event, promotionType decides whether the campaign
      // carries an end date.
      businessType: z.string().optional(),
      promotionType: z.string().optional(),
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const { campaign, alreadyBuilt, warnings } = await finishCampaignGenerationBuild(job.id, parsed.data);
    // `warnings` after the spread: the campaign carries no field of that name today, but spreading
    // it last would silently drop the budget advisory if one were ever added.
    res.json({ campaignId: campaign.id, alreadyBuilt, ...campaign, ...(warnings?.length ? { warnings } : {}) });
  } catch (err) {
    sendError(res, err, 422, "Could not build the campaign from this generation run");
  }
}));

router.post("/campaigns/generate/:id/select-strategy", asyncHandler(async (req: AuthedRequest, res) => {
  const job = await getCampaignGenerationJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Campaign generation job not found" });
  if (!(await getMembership(job.workspaceId, req.userId!))) {
    return res.status(403).json({ error: "You do not have access to this campaign generation job" });
  }
  const parsed = z.object({ strategy: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const { campaign, reusedWinner } = await buildCampaignForSelectedStrategy(job.id, parsed.data.strategy);
    res.json({ campaignId: campaign.id, reusedWinner, ...campaign });
  } catch (err) {
    sendError(res, err, 422, "Could not build a campaign for that strategy");
  }
}));

/* ═══════════════════════════════════════════════
   OPS — operational visibility into infra that has no other queryable surface.
   ═══════════════════════════════════════════════ */

router.get("/ops/dead-letter", requireOpsAccess, asyncHandler(async (req, res) => {
  const queue = typeof req.query.queue === "string" ? req.query.queue : undefined;
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
  res.json(await listDeadLetterEntries(queue, limit));
}));

/* ═══════════════════════════════════════════════
   PRODUCT IMPORT — extracted to scraper-service. Product URL -> Playwright ->
   images/metadata -> LLM, distinct from the onboarding scraper above (which
   crawls a whole business site with fetch+cheerio rather than a single
   JS-rendered product page).
   ═══════════════════════════════════════════════ */
const scraperProxy = proxyTo(SCRAPER_SERVICE_URL);
router.post("/products/scrape", scraperProxy);
router.post("/products/import", scraperProxy);

/* ═══════════════════════════════════════════════
   SUPPORT TICKETS
   ═══════════════════════════════════════════════ */

const supportTicketSchema = z.object({ subject: z.string().trim().min(1), message: z.string().trim().min(1) });

router.get("/workspaces/:id/support-tickets", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => res.json(await listSupportTickets(req.params.id))));
router.post("/workspaces/:id/support-tickets", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = supportTicketSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.status(201).json(await createSupportTicket(req.params.id, parsed.data));
}));

/* ═══════════════════════════════════════════════
   NOTIFICATION PREFERENCES
   ═══════════════════════════════════════════════ */

const notificationPreferencesSchema = z.object({ emailAlerts: z.boolean(), slackAlerts: z.boolean(), digestAlerts: z.boolean() });

router.get("/workspaces/:id/notification-preferences", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => res.json(await getNotificationPreferences(req.params.id))));
router.put("/workspaces/:id/notification-preferences", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = notificationPreferencesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(await setNotificationPreferences(req.params.id, parsed.data));
}));

/* ═══════════════════════════════════════════════
   RBAC ROLE MATRIX
   ═══════════════════════════════════════════════ */

router.get("/workspaces/:id/rbac-matrix", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => res.json(await getRbacMatrix(req.params.id))));
router.put("/workspaces/:id/rbac-matrix", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = z.record(z.record(z.boolean())).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(await setRbacMatrix(req.params.id, parsed.data));
}));

/* ═══════════════════════════════════════════════
   DEVELOPER PORTAL — webhooks & API key
   ═══════════════════════════════════════════════ */

router.get("/workspaces/:id/developer/webhooks", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => res.json(await listDeveloperWebhooks(req.params.id))));
router.post("/workspaces/:id/developer/webhooks", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = z.object({ url: z.string().url(), events: z.array(z.string()).min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.status(201).json(await createDeveloperWebhook(req.params.id, parsed.data));
}));
router.delete("/developer/webhooks/:id", requireDeveloperWebhookAccess, asyncHandler(async (req, res) => {
  const deleted = await deleteDeveloperWebhook(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
}));

router.get("/workspaces/:id/developer/api-key", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => res.json(await getOrCreateApiKey(req.params.id))));
router.post("/workspaces/:id/developer/api-key/regenerate", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => res.json(await regenerateApiKey(req.params.id))));

/* ═══════════════════════════════════════════════
   BILLING — payment method (mock; never stores a card number or CVC)
   ═══════════════════════════════════════════════ */

router.get("/workspaces/:id/payment-method", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => res.json(await getPaymentMethod(req.params.id))));
router.put("/workspaces/:id/payment-method", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = z.object({ cardNumber: z.string().min(1), expiry: z.string().min(1), cvc: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const validationError = validatePaymentMethodInput(parsed.data);
  if (validationError) return res.status(400).json({ error: validationError });
  res.json(await setPaymentMethod(req.params.id, parsed.data));
}));

// Manage Funds — the Ads Manager's funds panel. Returns BOTH the connected Meta ad account's real
// billing snapshot (balance/spend/cap/funding source + a deep link to Meta's own billing UI, since
// Meta owns the actual money) AND this workspace's internal wallet ledger (balance + transactions).
// Both are best-effort: `meta` is null when no account is connected / token expired, so the panel
// still renders the wallet side. No new spend authority — read-only + a deep link.
router.get("/workspaces/:id/funds", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const [meta, wallet, transactions] = await Promise.all([
    getAdAccountFunding(req.params.id).catch(() => null),
    getWalletBalance(req.params.id).catch(() => null),
    listWalletTransactions(req.params.id, 25).catch(() => []),
  ]);
  res.json({ meta, wallet, transactions });
}));

/* ═══════════════════════════════════════════════
   AUTOMATION RULES
   ═══════════════════════════════════════════════ */

const automationRuleSchema = z.object({
  name: z.string().trim().min(1),
  metric: z.string().trim().min(1),
  operator: z.enum(["gt", "lt", "eq"]),
  thresholdValue: z.number(),
  action: z.string().trim().min(1),
  actionParam: z.string().optional(),
  cooldownMinutes: z.number().int().nonnegative(),
  priority: z.enum(["low", "medium", "high"]),
});

router.get("/workspaces/:id/automation-rules", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => res.json(await listAutomationRules(req.params.id))));
router.post("/workspaces/:id/automation-rules", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = automationRuleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.status(201).json(await createAutomationRule(req.params.id, parsed.data));
}));
router.delete("/automation-rules/:id", requireAutomationRuleAccess, asyncHandler(async (req, res) => {
  const deleted = await deleteAutomationRule(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
}));

/* ═══════════════════════════════════════════════
   OPTIMIZATION GOAL (Optimize Goal page's budget/KPI section)
   ═══════════════════════════════════════════════ */

const optimizationGoalSchema = z.object({
  dailyBudgetCents: z.number().int().positive().max(MAX_BUDGET_CENTS),
  primaryKpi: z.string().trim().min(1),
  locations: z.array(z.string()),
});

router.get("/workspaces/:id/optimization-goal", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => res.json(await getOptimizationGoal(req.params.id))));
router.put("/workspaces/:id/optimization-goal", requireWorkspaceMember("params", "id"), asyncHandler(async (req, res) => {
  const parsed = optimizationGoalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(await setOptimizationGoal(req.params.id, parsed.data));
}));

// Consistent JSON 404 for anything under /api that didn't match a route above,
// instead of Express's default HTML error page.
router.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});
