import { prisma } from "../../db/prisma.js";
import { getMetaCredentials, markMetaConnectionError } from "./integrationService.js";
import type { Integration } from "./integrationService.js";
import { logger } from "../logger/logger.js";

/**
 * Periodic Meta token health check.
 *
 * ── Why this and not the token REFRESH that already exists ───────────────────────────────────
 * `refreshAllExpiringTokens` was written but never scheduled, and scheduling it would not have
 * helped this deployment: `refreshMetaToken` requires META_APP_ID/META_APP_SECRET, and both are
 * unset here, so a refresh cannot run at all. It also keys off `settings.tokenExpiresAt`, which the
 * MANUAL connect path never stored (it is null on the live connection) — so the refresh sweep would
 * have found nothing to do even if it could act.
 *
 * What DOES work without app credentials is asking Meta about the token using the token itself:
 * `debug_token?input_token=T&access_token=T`. That returns validity and the real expiry, which is
 * the information actually needed to stop a silent failure at publish time.
 *
 * Checked against the live connection: `expires_at: 0` — a non-expiring PAGE token — so the failure
 * mode I originally assumed (tokens quietly ageing out and publishes breaking with code 190) does
 * NOT apply to it. This check exists so that assumption never has to be made again: whatever kind of
 * token a workspace connects, its real expiry and validity are recorded, and an invalid one flips the
 * integration to `error` so the UI prompts a reconnect instead of a launch failing mid-publish.
 */

const GRAPH_BASE = "https://graph.facebook.com/v22.0";

/** Warn this far ahead of a real expiry, so there is time to reconnect before publishing breaks. */
const EXPIRY_WARNING_DAYS = Math.max(1, Number(process.env.META_TOKEN_EXPIRY_WARNING_DAYS ?? 14));

export interface MetaTokenHealth {
  workspaceId: string;
  valid: boolean;
  /** ISO expiry, or null when the token does not expire (Meta reports expires_at: 0). */
  expiresAt: string | null;
  /** Whole days until expiry; null when it never expires. */
  daysRemaining: number | null;
  tokenType?: string;
  error?: string;
}

/** Ask Meta about a token USING THAT TOKEN — no app id/secret required, unlike refreshMetaToken. */
async function debugTokenSelf(accessToken: string): Promise<{ valid: boolean; expiresAt: string | null; type?: string; error?: string }> {
  try {
    const url = `${GRAPH_BASE}/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url);
    const json = (await res.json()) as { data?: { is_valid?: boolean; expires_at?: number; type?: string }; error?: { message?: string } };
    if (!res.ok || json.error) return { valid: false, expiresAt: null, error: json.error?.message ?? `debug_token returned ${res.status}` };
    const data = json.data ?? {};
    // expires_at === 0 means "does not expire" (long-lived page / system-user token), which is very
    // different from "unknown" — recording it as null WITH valid:true keeps that distinction.
    const expiresAt = data.expires_at && data.expires_at > 0 ? new Date(data.expires_at * 1000).toISOString() : null;
    return { valid: Boolean(data.is_valid), expiresAt, type: data.type };
  } catch (err) {
    return { valid: false, expiresAt: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Check one workspace's Meta token and persist what we learn.
 *
 * Never throws: this runs on a timer and must not take a worker down. A network failure is reported
 * as `valid:false` WITHOUT flipping the integration to `error`, because a blip is not a dead token —
 * only Meta explicitly saying the token is invalid does that.
 */
export async function verifyMetaTokenHealth(workspaceId: string): Promise<MetaTokenHealth | null> {
  const credentials = await getMetaCredentials(workspaceId);
  if (!credentials) return null; // not connected — nothing to check

  const result = await debugTokenSelf(credentials.accessToken);
  const daysRemaining = result.expiresAt ? Math.floor((Date.parse(result.expiresAt) - Date.now()) / 86_400_000) : null;

  // Persist what we learned so the UI and future checks can see it without re-querying Meta. The
  // manual-connect path never recorded an expiry at all, which is why this was invisible.
  const row = await prisma.integration.findFirst({ where: { workspaceId, platform: "meta" } });
  if (row) {
    const data = row.data as unknown as Integration;
    await prisma.integration.update({
      where: { id: row.id },
      data: {
        data: {
          ...data,
          settings: {
            ...data.settings,
            tokenExpiresAt: result.expiresAt,
            tokenNeverExpires: result.valid && result.expiresAt === null,
            tokenType: result.type,
            tokenCheckedAt: new Date().toISOString(),
          },
        } as object,
      },
    });
  }

  if (!result.valid) {
    if (result.error) {
      // Could not reach Meta — do NOT mark the connection dead over a transient failure.
      logger.warn(`verifyMetaTokenHealth: could not verify ${workspaceId}'s Meta token — ${result.error}`);
    } else {
      logger.error(`verifyMetaTokenHealth: Meta reports ${workspaceId}'s token is INVALID — flagging the connection for reconnect`);
      await markMetaConnectionError(workspaceId, "Meta access token is no longer valid — reconnect your Meta account to keep publishing.").catch(() => {});
    }
  } else if (daysRemaining !== null && daysRemaining <= EXPIRY_WARNING_DAYS) {
    logger.warn(
      `verifyMetaTokenHealth: ${workspaceId}'s Meta token expires in ${daysRemaining} day(s) (${result.expiresAt}). ` +
        `Automatic refresh needs META_APP_ID/META_APP_SECRET — ${process.env.META_APP_ID && process.env.META_APP_SECRET ? "configured" : "NOT configured on this deployment, so a manual reconnect will be required"}.`
    );
  }

  return { workspaceId, valid: result.valid, expiresAt: result.expiresAt, daysRemaining, tokenType: result.type, error: result.error };
}

/** Check every workspace that has a Meta integration row. Best-effort per workspace. */
export async function verifyAllMetaTokenHealth(): Promise<MetaTokenHealth[]> {
  const rows = await prisma.integration.findMany({ where: { platform: "meta" }, select: { workspaceId: true } });
  const results: MetaTokenHealth[] = [];
  for (const { workspaceId } of rows) {
    try {
      const health = await verifyMetaTokenHealth(workspaceId);
      if (health) results.push(health);
    } catch (err) {
      logger.warn(`verifyAllMetaTokenHealth: check failed for workspace ${workspaceId}`, err);
    }
  }
  const invalid = results.filter((r) => !r.valid && !r.error).length;
  logger.info(`verifyAllMetaTokenHealth: checked ${results.length} Meta connection(s), ${invalid} invalid`);
  return results;
}
