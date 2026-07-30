import "dotenv/config";
import express, { type Request } from "express";
import cors from "cors";
import helmet from "helmet";
import { router, authEntryRouter } from "./gateway/router.js";
import { metaOAuthRoutes } from "./gateway/metaOAuthRoutes.js";
import { googleOAuthRoutes } from "./gateway/googleOAuthRoutes.js";
import { tiktokOAuthRoutes } from "./gateway/tiktokOAuthRoutes.js";
import { shopifyOAuthRoutes } from "./gateway/shopifyOAuthRoutes.js";
import { shopifyWebhookRoutes } from "./gateway/shopifyWebhookRoutes.js";
import { metaLeadWebhookRoutes } from "./gateway/metaLeadWebhookRoutes.js";
import { adsDataRoutes } from "./gateway/adsDataRoutes.js";
import { sseStreamRoutes } from "./gateway/sseStreamRoutes.js";
import { crmInternalAuth } from "./gateway/middleware/crmInternalAuth.js";
import { apiRateLimiter } from "./gateway/middleware/rateLimit.js";
import { requireAuth } from "./gateway/middleware/auth.js";
import { OBJECTS_ROOT } from "./infra/objectStorage.js";
import { registerEventHandlers } from "./infra/eventHandlers.js";
import { attachWebSocketServer } from "./infra/websocketServer.js";
import { startRealtimeBridge } from "./infra/realtimeBridge.js";
import { prisma } from "./db/prisma.js";
import { redisClient } from "./infra/redisClient.js";
import { logger } from "./modules/logger/logger.js";
import { initErrorTracking, registerCrashReporting, captureError } from "./infra/errorTracking.js";

initErrorTracking("polluxa-api");
registerCrashReporting("polluxa-api");

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

registerEventHandlers();

app.use(helmet());

const IS_PROD = process.env.NODE_ENV === "production";

// In production the app sits behind a proxy chain (host nginx → Traefik → container, or the web
// container's nginx → api). Without this, req.ip is the proxy's address, so express-rate-limit
// buckets EVERY client together (the auth limiter's 10/15min would then lock out all users at
// once) and it logs an ERR_ERL_UNEXPECTED_X_FORWARDED_FOR validation error. TRUST_PROXY_HOPS is
// the number of trusted proxies in front of this process (default 1 = the immediate reverse
// proxy); set it to the actual hop count so a client can't spoof X-Forwarded-For past the ones
// we control. Left off entirely in dev (no proxy), where req.ip is already the real client.
if (IS_PROD) app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 1));

const ALLOWED_ORIGINS = IS_PROD
  ? [process.env.PUBLIC_ORIGIN, process.env.CRM_ORIGIN].filter(Boolean) as string[]
  : true;
app.use(cors(IS_PROD ? { origin: ALLOWED_ORIGINS, credentials: true } : { origin: true, credentials: true }));

// 10mb (up from body-parser's 100kb default): the onboarding flow round-trips a full ScrapedSite
// — crawled page text + a base64 screenshot — back to /onboarding/analyze-product, which for a
// content-rich site (e.g. polluxa.com ≈ 2.7mb) blew past 100kb and 413'd the whole parse step.
app.use(express.json({ limit: "10mb", verify: (req: Request & { rawBody?: Buffer }, _res, buf) => { req.rawBody = buf; } }));
app.use(apiRateLimiter);

// Real connectivity checks, not a static "ok" — a gateway that can't reach Postgres or
// Redis is not actually healthy even though the Express process itself is up, and a
// load balancer/orchestrator relying on this endpoint needs to know that to route traffic
// (or restart the pod) accordingly. Each check is independent so one down dependency's
// failure doesn't throw before the other is checked.
app.get("/health", async (_req, res) => {
  const checks: Record<string, "ok" | "error"> = { postgres: "ok", redis: "ok" };

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    checks.postgres = "error";
    logger.error("Health check: Postgres unreachable", err);
  }

  try {
    await redisClient.ping();
  } catch (err) {
    checks.redis = "error";
    logger.error("Health check: Redis unreachable", err);
  }

  const healthy = Object.values(checks).every((status) => status === "ok");
  res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", checks });
});

// Serves blobs written via LocalFileObjectStorage (src/infra/objectStorage.ts) — a real
// S3/GCS/R2-backed implementation drops this static route in favor of signed URLs.
//
// OBJECTS_ROOT is imported rather than recomputed here on purpose. This line used to resolve the
// directory from its own __dirname, one level shallower than objectStorage.ts did, and the two only
// agreed because the extra ".." cancelled against the src/ layout. The Docker image flattens
// apps/api/dist to /repo/service/dist, so both silently pointed somewhere the mounted volume wasn't.
app.use("/objects", express.static(OBJECTS_ROOT));

// Unauthenticated — Facebook's/Google's/TikTok's OAuth redirects carry no bearer token (see the respective routes files).
app.use("/api/integrations/meta/oauth", metaOAuthRoutes);
app.use("/api/integrations/google/oauth", googleOAuthRoutes);
app.use("/api/integrations/tiktok/oauth", tiktokOAuthRoutes);
app.use("/api/integrations/shopify/oauth", shopifyOAuthRoutes);

// Unauthenticated at the HTTP layer by necessity (Meta/Shopify call these directly) —
// authenticity is instead verified per-request via each platform's own HMAC scheme (see
// the respective route files).
app.use("/api/webhooks/meta", metaLeadWebhookRoutes);
app.use("/api/webhooks/shopify", shopifyWebhookRoutes);

// Server-to-server only: sales_tech_backend (the CRM) proxies its browser requests here
// with a shared secret (see crmInternalAuth) — never called directly from a browser.
app.use("/api/crm", crmInternalAuth, adsDataRoutes);

// Register/login/google: no bearer token exists yet when calling these, so they're
// mounted ahead of requireAuth (falls through to the gated router below if unmatched).
app.use("/api", authEntryRouter);
app.use("/api", requireAuth, sseStreamRoutes);
app.use("/api", requireAuth, router);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  captureError(err, { service: "polluxa-api" });
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(PORT, () => {
  console.log(`Polluxa API gateway listening on http://localhost:${PORT}`);
  warnIfRunningEveryAdNetworkInMockMode();
});

// Real-time layer: WebSocket server on the same HTTP port, plus Redis Pub/Sub
// bridge that forwards worker-emitted events to connected browsers.
attachWebSocketServer(server);
const stopRealtimeBridge = startRealtimeBridge();

/**
 * A workspace "connecting" Meta/Google/TikTok when no app credentials are registered
 * completes a clearly-labeled mock connection (see metaOAuth.ts/googleOAuth.ts/
 * tiktokOAuth.ts's own mock-connect fallbacks) rather than erroring — reasonable for local
 * dev/demo, but a real production deployment running with every network unconfigured means
 * no ad account a user "connects" is ever real, which is worth a loud operator-facing
 * signal instead of only being discoverable by a confused user noticing "(mock)" in an
 * account name. Not a hard error — an operator may genuinely intend a mock-only demo
 * deployment — just a warning that can't be missed in the startup log.
 */
function warnIfRunningEveryAdNetworkInMockMode(): void {
  if (process.env.NODE_ENV !== "production") return;
  const hasAnyRealAdNetworkApp = Boolean(
    (process.env.META_APP_ID && process.env.META_APP_SECRET) ||
    (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) ||
    (process.env.TIKTOK_APP_ID && process.env.TIKTOK_APP_SECRET)
  );
  if (!hasAnyRealAdNetworkApp) {
    logger.warn(
      "STARTUP WARNING: NODE_ENV=production but no Meta/Google/TikTok app credentials are configured — " +
      "every workspace's ad-network 'Connect' button will complete a mock connection, not a real one. " +
      "Set META_APP_ID/META_APP_SECRET, GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET, and/or " +
      "TIKTOK_APP_ID/TIKTOK_APP_SECRET if real ad-account connections are expected in this deployment."
    );
  }
}

// Stop accepting new connections and let in-flight requests finish before exiting —
// without this, a deploy/restart (SIGTERM) or Ctrl+C (SIGINT) kills requests mid-flight,
// which for this gateway can mean a client never learns whether a campaign launch or
// research job it just triggered actually started. A second signal (or the timeout)
// still forces the process down rather than hanging forever on one stuck connection.
const SHUTDOWN_FORCE_EXIT_MS = 10_000;
let shuttingDown = false;

function gracefulShutdown(signal: string) {
  if (shuttingDown) {
    logger.warn(`Received ${signal} again during shutdown — forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;
  logger.info(`Received ${signal} — closing gracefully (in-flight requests get ${SHUTDOWN_FORCE_EXIT_MS}ms to finish)`);

  const forceExit = setTimeout(() => {
    logger.error(`Graceful shutdown timed out after ${SHUTDOWN_FORCE_EXIT_MS}ms — forcing exit`);
    process.exit(1);
  }, SHUTDOWN_FORCE_EXIT_MS);
  forceExit.unref();

  stopRealtimeBridge();
  server.close((err) => {
    if (err) logger.error("Error while closing HTTP server", err);
    process.exit(err ? 1 : 0);
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
