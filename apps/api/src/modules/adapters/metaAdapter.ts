import type {
  AdAdapter,
  HierarchyCapableAdapter,
  LaunchVariantInput,
  LaunchVariantResult,
  SetBudgetInput,
  MetaCredentials,
  CampaignContainerInput,
  AdSetContainerInput,
  CreativeUploadInput,
  CreativeUploadResult,
  HierarchyAdInput,
} from "./AdAdapter.js";
import { resolveOptimizationGoal } from "./metaObjectives.js";
import { logger } from "../logger/logger.js";

const GRAPH_VERSION = "v22.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Meta Insights date_preset values the Ads Manager range picker may request. Anything not in this
// set (e.g. a daily YYYY-MM-DD from the ingestion worker) is ignored and Meta's default window used.
const META_DATE_PRESETS = new Set(["today", "last_7d", "last_14d", "last_30d", "last_90d", "maximum"]);

const ENV_META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const ENV_META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;
const hasLiveCredentials = Boolean(ENV_META_ACCESS_TOKEN && ENV_META_AD_ACCOUNT_ID);

function mockId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Three-tier fallback, same shape as every other adapter in this file: explicit
 * per-workspace OAuth credentials (Phase B) > global env-var credentials (legacy,
 * still supported for single-tenant/local setups) > null (mock mode).
 */
function resolveCredentials(explicit?: MetaCredentials): MetaCredentials | null {
  // Every call site builds the Graph path as `act_${adAccountId}`, so the stored id must be BARE.
  // The CRM SSO handoff (and some OAuth flows) persist it already-prefixed as `act_<n>`, which
  // otherwise yields `act_act_<n>` and a GraphMethodException (subcode 33, "object does not exist").
  // Normalize here, once, so all six endpoints get exactly one prefix regardless of source.
  const bare = (c: MetaCredentials): MetaCredentials =>
    c.adAccountId ? { ...c, adAccountId: String(c.adAccountId).replace(/^act_/, "") } : c;
  if (explicit) return bare(explicit);
  if (hasLiveCredentials) return bare({ accessToken: ENV_META_ACCESS_TOKEN!, adAccountId: ENV_META_AD_ACCOUNT_ID!, currency: "USD" });
  return null;
}

/**
 * Meta's minor-unit rules aren't a flat "always cents": zero-decimal currencies (JPY,
 * KRW, ...) have no minor unit at all, and a few (KWD, BHD, ...) use three decimal
 * places. `dailyBudgetCents` in this app is always `wholeUnits * 100` (the UI takes a
 * dollar-style amount), so recovering wholeUnits and reapplying the account's real
 * divisor keeps USD/EUR/INR-style accounts unchanged while fixing the outliers.
 */
const META_MINOR_UNIT_DIVISORS: Record<string, number> = {
  JPY: 1, KRW: 1, VND: 1, CLP: 1, HUF: 1, ISK: 1, TWD: 1, IDR: 1, MMK: 1, UGX: 1, GNF: 1, MGA: 1, PYG: 1, RWF: 1, XAF: 1, XOF: 1,
  KWD: 1000, BHD: 1000, OMR: 1000, JOD: 1000,
};

function toMetaMinorUnits(dailyBudgetCents: number, currency: string): number {
  const wholeUnits = dailyBudgetCents / 100;
  const divisor = META_MINOR_UNIT_DIVISORS[currency.toUpperCase()] ?? 100;
  return Math.round(wholeUnits * divisor);
}

/**
 * Meta rejects an ad set whose daily budget is below its per-currency minimum (error subcode
 * 1885272, "Budget is too low") — an ad set under the floor never delivers, so publishing a
 * split-too-thin budget silently fails every variant. A campaign budget divided across several
 * audience ad sets easily drops each below the floor (e.g. $50 / 16 variants on an INR account).
 * We floor each ad set to the minimum: spending the viable minimum beats not delivering at all.
 * Values are Meta's documented ~$1-equivalent/day minimums in WHOLE currency units; unknown
 * currencies fall back to the USD-equivalent 100 cents. Currency-scaled, not a flat number.
 */
const META_MIN_DAILY_BUDGET_WHOLE_UNITS: Record<string, number> = {
  USD: 1, EUR: 1, GBP: 1, CAD: 1, AUD: 1, SGD: 1,
  INR: 100, JPY: 100, MXN: 20, BRL: 5, ZAR: 20, THB: 40, PHP: 60, TRY: 20,
};

function floorAdSetBudgetCents(dailyBudgetCents: number, currency: string): number {
  const minWhole = META_MIN_DAILY_BUDGET_WHOLE_UNITS[currency.toUpperCase()] ?? 1;
  const minCents = minWhole * 100; // app-internal budgets are always wholeUnits * 100
  return Math.max(dailyBudgetCents, minCents);
}

// Meta rejects campaign/ad-set/ad/creative names over 400 chars (Graph API error subcode
// 2446443, "Name is too long"). Ad-set names are built from the strategy's free-text
// audienceName, which can be a multi-sentence paragraph — so clamp every name at the adapter
// boundary rather than trusting each caller. 380 leaves headroom for the "-creative" suffix.
const META_MAX_NAME_LENGTH = 380;
function clampName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length <= META_MAX_NAME_LENGTH ? trimmed : trimmed.slice(0, META_MAX_NAME_LENGTH - 1).trimEnd() + "…";
}

// Meta's call_to_action.type is a fixed enum — a free-text CTA (e.g. "Book Live Demo") 400s the
// Graph API. Map the creative's CTA text to the closest valid enum, defaulting to LEARN_MORE.
const META_CTA_TYPES = new Set([
  "LEARN_MORE", "SHOP_NOW", "SIGN_UP", "SUBSCRIBE", "BOOK_TRAVEL", "BOOK_NOW", "DOWNLOAD",
  "GET_QUOTE", "CONTACT_US", "APPLY_NOW", "GET_OFFER", "ORDER_NOW", "DONATE_NOW", "SEE_MENU",
  "WATCH_MORE", "LISTEN_NOW", "PLAY_GAME", "GET_SHOWTIMES", "REQUEST_TIME", "SEND_MESSAGE",
  "CALL_NOW", "WHATSAPP_MESSAGE", "NO_BUTTON",
]);
// Common label/free-text → enum aliases (keys normalized: uppercased, spaces→underscore).
const META_CTA_ALIASES: Record<string, string> = {
  SHOP: "SHOP_NOW", BUY_NOW: "SHOP_NOW", BUY: "SHOP_NOW", ORDER: "ORDER_NOW",
  REGISTER: "SIGN_UP", JOIN_NOW: "SIGN_UP", GET_STARTED: "SIGN_UP", START_NOW: "SIGN_UP",
  START_FREE_TRIAL: "SIGN_UP", TRY_FREE: "SIGN_UP", FREE_TRIAL: "SIGN_UP",
  BOOK: "BOOK_NOW", BOOK_A_DEMO: "BOOK_NOW", BOOK_DEMO: "BOOK_NOW", BOOK_LIVE_DEMO: "BOOK_NOW",
  REQUEST_A_DEMO: "REQUEST_TIME", REQUEST_DEMO: "REQUEST_TIME", GET_A_QUOTE: "GET_QUOTE",
  GET_DEMO: "BOOK_NOW", CONTACT: "CONTACT_US", CALL: "CALL_NOW", MESSAGE_US: "SEND_MESSAGE",
  DONATE: "DONATE_NOW", INSTALL_NOW: "DOWNLOAD", INSTALL: "DOWNLOAD", GET_APP: "DOWNLOAD",
  WATCH: "WATCH_MORE", LISTEN: "LISTEN_NOW", SEE_MORE: "LEARN_MORE", READ_MORE: "LEARN_MORE",
  APPLY: "APPLY_NOW", SUBSCRIBE_NOW: "SUBSCRIBE",
};
export function toMetaCtaType(cta?: string): string {
  if (!cta) return "LEARN_MORE";
  const key = cta.trim().toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z_]/g, "");
  if (META_CTA_TYPES.has(key)) return key;
  return META_CTA_ALIASES[key] ?? "LEARN_MORE";
}

/**
 * A classified Graph API failure. Carries Meta's own error taxonomy (code / error_subcode /
 * error_user_msg / fbtrace_id) so callers can branch on it — the orchestrator refreshes the
 * token on an auth error, the route surfaces the human-readable error_user_msg, and
 * fetchWithRetry decides retryable-vs-not — instead of everyone re-regexing a flat string.
 */
export class MetaGraphError extends Error {
  readonly httpStatus: number;
  readonly code?: number;
  readonly subcode?: number;
  /** Meta's end-user-safe message (error_user_title/error_user_msg) — safe to show a user, unlike `message`. */
  readonly userMessage?: string;
  readonly fbtraceId?: string;
  readonly isAuthError: boolean;
  readonly isRateLimit: boolean;
  constructor(args: {
    message: string;
    httpStatus: number;
    code?: number;
    subcode?: number;
    userMessage?: string;
    fbtraceId?: string;
    isAuthError: boolean;
    isRateLimit: boolean;
  }) {
    super(args.message);
    this.name = "MetaGraphError";
    this.httpStatus = args.httpStatus;
    this.code = args.code;
    this.subcode = args.subcode;
    this.userMessage = args.userMessage;
    this.fbtraceId = args.fbtraceId;
    this.isAuthError = args.isAuthError;
    this.isRateLimit = args.isRateLimit;
  }
}

// Meta rate-limit signals: top-level codes 4 (app-level), 17 (per-user), 32 (page-level),
// 613 (custom/ads), 80000+ (business-use-case throttling), plus error_subcode 2446079. On any
// of these, backing off and retrying is correct; on a plain 400 (bad budget/name/objective) it
// is not — retrying just wastes ~1.5s before failing with the same error.
const META_RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80014]);
// Auth failures: code 190 (invalid/expired token) and the OAuthException subcodes for expired
// session (463), changed password (460), untrusted device (461), etc. These are non-retryable
// at the HTTP level but ARE recoverable by refreshing the token, which the orchestrator does.
const META_AUTH_CODES = new Set([190, 102, 10, 200, 2500]);
const META_AUTH_SUBCODES = new Set([458, 459, 460, 461, 463, 464, 467, 492]);

/** Parses a Graph API error body (already read as text) into a classified MetaGraphError. */
function classifyMetaError(httpStatus: number, bodyText: string): MetaGraphError {
  let err: any = {};
  try {
    err = JSON.parse(bodyText)?.error ?? {};
  } catch {
    // Non-JSON body (e.g. an HTML 502 from a proxy) — no Meta taxonomy to extract.
  }
  const code: number | undefined = typeof err.code === "number" ? err.code : undefined;
  const subcode: number | undefined = typeof err.error_subcode === "number" ? err.error_subcode : undefined;
  const isAuthError =
    err.type === "OAuthException" ||
    (code != null && META_AUTH_CODES.has(code)) ||
    (subcode != null && META_AUTH_SUBCODES.has(subcode));
  const isRateLimit =
    httpStatus === 429 ||
    (code != null && META_RATE_LIMIT_CODES.has(code)) ||
    subcode === 2446079;
  const userMessage = err.error_user_msg
    ? `${err.error_user_title ? err.error_user_title + ": " : ""}${err.error_user_msg}`
    : undefined;
  const message = `Meta API ${httpStatus}${code != null ? ` (code ${code}${subcode != null ? `/${subcode}` : ""})` : ""}: ${err.message ?? bodyText.slice(0, 300)}`;
  return new MetaGraphError({ message, httpStatus, code, subcode, userMessage, fbtraceId: err.fbtrace_id, isAuthError, isRateLimit });
}

// A non-2xx is retryable only when it's transient: HTTP 5xx (server-side) or a rate limit.
// A 4xx that isn't a rate limit is a hard client error (bad budget, name too long, invalid
// objective, invalid/expired token) — retrying it is pointless, so we fail fast.
function isRetryableMetaError(e: MetaGraphError): boolean {
  return e.httpStatus >= 500 || e.isRateLimit;
}

const MAX_RETRY_DELAY_MS = 60_000;

// Exponential Backoff Retry Helper. Only retries transient failures (5xx / rate limit); a hard
// 4xx (bad request, invalid token) throws a classified MetaGraphError immediately instead of
// burning three attempts. Honors Retry-After on rate-limit responses when present.
async function fetchWithRetry(url: string, options: RequestInit, retries = 3, delay = 500): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    let backoffMs = delay * Math.pow(2, i);
    try {
      logger.info(`Sending Request: ${options.method || "GET"} ${url.split("?")[0]} (Attempt ${i + 1}/${retries})`);
      const res = await fetch(url, options);
      if (res.ok) {
        return res;
      }
      const bodyText = await res.text().catch(() => "");
      const classified = classifyMetaError(res.status, bodyText);
      // Fail fast on non-retryable client errors — don't waste retries on a 400/401/403.
      if (!isRetryableMetaError(classified)) {
        logger.warn(`Meta Ads API ${res.status} (non-retryable${classified.code != null ? ` code ${classified.code}` : ""}) — not retrying: ${classified.message}`);
        throw classified;
      }
      logger.warn(`Meta Ads API returned status ${res.status} (retryable). Attempt ${i + 1} failed.`);
      if (i === retries - 1) throw classified;
      // On a rate limit, prefer the server's Retry-After (seconds) over our own backoff.
      const retryAfter = typeof (res.headers as any)?.get === "function" ? (res.headers as any).get("retry-after") : null;
      if (classified.isRateLimit && retryAfter && !Number.isNaN(Number(retryAfter))) {
        backoffMs = Math.min(Number(retryAfter) * 1000, MAX_RETRY_DELAY_MS);
      }
    } catch (err) {
      // A classified, non-retryable Meta error must propagate immediately (don't fall into the
      // backoff/retry loop below — that's only for transient network/5xx failures).
      if (err instanceof MetaGraphError && !isRetryableMetaError(err)) throw err;
      logger.error(`Network Exception on Meta Ads fetch attempt ${i + 1}`, err);
      if (i === retries - 1) throw err;
    }
    await new Promise(r => setTimeout(r, backoffMs));
  }
  throw new Error("Meta Ads HTTP request failed after maximum retries");
}

async function graphPost(path: string, accessToken: string, body: Record<string, unknown>): Promise<any> {
  const url = `${GRAPH_BASE}${path}?access_token=${accessToken}`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

const VIDEO_POLL_INTERVAL_MS = 3000;
const VIDEO_POLL_MAX_ATTEMPTS = 40; // ~2 minutes

/**
 * Meta processes an uploaded video asynchronously — referencing its video_id in an ad
 * creative before processing finishes can fail. Polls status until ready/error/timeout
 * instead of trusting the upload response the way a naive integration would.
 */
async function waitForVideoProcessing(videoId: string, accessToken: string): Promise<void> {
  for (let attempt = 0; attempt < VIDEO_POLL_MAX_ATTEMPTS; attempt++) {
    const url = `${GRAPH_BASE}/${videoId}?fields=status&access_token=${accessToken}`;
    const res = await fetchWithRetry(url, { method: "GET" });
    const json = (await res.json()) as { status?: { video_status?: string } };
    const videoStatus = json.status?.video_status;
    if (videoStatus === "ready") return;
    if (videoStatus === "error") throw new Error(`Meta video ${videoId} failed processing`);
    await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
  }
  throw new Error(`Meta video ${videoId} did not finish processing in time`);
}

async function setStatus(externalId: string, status: "PAUSED" | "ACTIVE", credentials?: MetaCredentials): Promise<void> {
  logger.info(`Setting Meta resource ${externalId} status to ${status}`);
  const creds = resolveCredentials(credentials);
  if (!creds) {
    logger.info(`Offline mode. Mock ${status === "ACTIVE" ? "activating" : "pausing"} Meta ad variant.`);
    return;
  }
  try {
    const url = `${GRAPH_BASE}/${externalId}?access_token=${creds.accessToken}`;
    await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    logger.info(`Meta resource ${externalId} status set to ${status}`);
  } catch (err) {
    logger.error(`Failed to set Meta resource ${externalId} status to ${status}`, err);
    throw err;
  }
}

export const metaAdapter: AdAdapter & HierarchyCapableAdapter = {
  network: "meta",

  async launchVariant(input: LaunchVariantInput, credentials?: MetaCredentials): Promise<LaunchVariantResult> {
    logger.info(`Initializing launchVariant on Meta Marketing network for campaign: ${input.campaignId}`);

    // Resolve per-workspace credentials FIRST (explicit > global env > null). Never read the
    // global env tokens without checking the explicit workspace credentials — otherwise a caller
    // that doesn't thread creds through would publish into whatever global ad account the env
    // vars happen to point at, cross-tenant.
    const creds = resolveCredentials(credentials);
    if (!creds) {
      logger.info("Credentials absent. Falling back to Meta Ads mock placement.");
      return { externalId: mockId("meta_ad"), status: "active" };
    }

    try {
      const url = `${GRAPH_BASE}/act_${creds.adAccountId}/ads?access_token=${creds.accessToken}`;
      const res = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${input.campaignId}-${input.variantId}`,
          status: "ACTIVE",
          creative: input.creative,
        }),
      });

      const json = (await res.json()) as any;

      if (!json || !json.id) {
        throw new Error("Malformed Meta Marketing API response payload. Missing 'id' parameter.");
      }

      logger.info(`Meta Marketing ad campaign variant placed successfully: ${json.id}`);
      return { externalId: json.id, status: "active" };
    } catch (err) {
      logger.error("Failed to launch campaign variant on Meta Marketing Ads API", err);
      throw err;
    }
  },

  async pauseVariant(externalId: string, credentials?: MetaCredentials): Promise<void> {
    return setStatus(externalId, "PAUSED", credentials);
  },

  async activateVariant(externalId: string, credentials?: MetaCredentials): Promise<void> {
    return setStatus(externalId, "ACTIVE", credentials);
  },

  async setBudget(input: SetBudgetInput, credentials?: MetaCredentials): Promise<void> {
    logger.info(`Updating daily budget for Meta Ads resource: ${input.externalId} to ${input.dailyBudgetCents} cents`);
    const creds = resolveCredentials(credentials);
    if (!creds) {
      logger.info("Offline mode. Mock budget change complete.");
      return;
    }

    try {
      const url = `${GRAPH_BASE}/${input.externalId}?access_token=${creds.accessToken}`;
      await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daily_budget: toMetaMinorUnits(input.dailyBudgetCents, creds.currency) }),
      });
      logger.info("Meta daily campaign budget successfully modified.");
    } catch (err) {
      logger.error("Failed to modify daily budget on Meta Ads API", err);
      throw err;
    }
  },

  async fetchInsights(externalId: string, dateOrPreset?: string, credentials?: MetaCredentials) {
    logger.info(`Fetching performance insights for Meta Ads resource: ${externalId}`);
    const creds = resolveCredentials(credentials);

    if (!creds) {
      // No connected Meta account → NO fabricated metrics. Return real zeros so the pipeline and
      // every downstream surface (Analytics, Dashboard, Ads Manager) show an honest "no data yet"
      // state instead of Math.random()-invented performance presented as real.
      logger.info(`No Meta credentials for ${externalId} — returning zero metrics (no fabricated data).`);
      return { impressions: 0, reach: 0, clicks: 0, conversions: 0, spendCents: 0, revenueCents: 0 };
    }

    try {
      // Honor a Meta date_preset (last_7d/last_14d/last_30d/last_90d/today/maximum) when the caller
      // passes one, so the Ads Manager date-range picker actually scopes the numbers. A bare
      // YYYY-MM-DD (the daily-ingestion caller) or nothing falls through to Meta's default window.
      const preset = META_DATE_PRESETS.has(dateOrPreset ?? "") ? `&date_preset=${dateOrPreset}` : "";
      // action_values carries the real purchase VALUE (revenue) per action_type, parallel to
      // `actions` which carries the COUNT — both are needed for true ROAS (revenue / spend).
      const url = `${GRAPH_BASE}/${externalId}/insights?fields=impressions,reach,clicks,actions,action_values,spend${preset}&access_token=${creds.accessToken}`;
      const res = await fetchWithRetry(url, { method: "GET" });
      const json = (await res.json()) as any;

      if (!json || !json.data) {
        logger.warn(`No stats returned in data array for Meta Ads resource: ${externalId}. Returning zero metrics.`);
        return { impressions: 0, reach: 0, clicks: 0, conversions: 0, spendCents: 0, revenueCents: 0 };
      }

      const row = json.data[0] || {};
      const actions: any[] = row.actions || [];
      const actionValues: any[] = row.action_values || [];
      // Meta reports each conversion step under its own action_type; naming varies across pixel
      // setups (bare `purchase` vs the fully-qualified `offsite_conversion.fb_pixel_purchase`),
      // so match either spelling. Sum in case both the generic and qualified rows are present
      // would double-count, so prefer the first match per step, in specificity order.
      const actionCount = (types: string[]): number => {
        for (const t of types) {
          const hit = actions.find((a) => a.action_type === t)?.value;
          if (hit != null) return Number(hit);
        }
        return 0;
      };
      const conversions = actionCount(["offsite_conversion"]);
      const addToCart = actionCount(["offsite_conversion.fb_pixel_add_to_cart", "add_to_cart"]);
      const addPaymentInfo = actionCount(["offsite_conversion.fb_pixel_add_payment_info", "add_payment_info"]);
      const purchases = actionCount(["offsite_conversion.fb_pixel_purchase", "purchase"]);
      // Real revenue: the monetary value Meta attributes to the purchase pixel. Prefer the
      // generic `offsite_conversion` value; fall back to the explicit purchase action types some
      // pixel setups report under instead. In the account currency (dollars) → convert to cents.
      const revenueDollars =
        actionValues.find((a) => a.action_type === "offsite_conversion")?.value ??
        actionValues.find((a) => a.action_type === "offsite_conversion.fb_pixel_purchase")?.value ??
        actionValues.find((a) => a.action_type === "purchase")?.value ??
        0;
      const purchaseValueCents = Math.round(Number(revenueDollars) * 100);

      const stats = {
        impressions: Number(row.impressions ?? 0),
        reach: Number(row.reach ?? 0),
        clicks: Number(row.clicks ?? 0),
        conversions: Number(conversions),
        spendCents: Math.round(Number(row.spend ?? 0) * 100),
        revenueCents: purchaseValueCents,
        funnel: { addToCart, addPaymentInfo, purchases, purchaseValueCents },
      };

      logger.info(`Meta Ads insights fetched: Clicks: ${stats.clicks}, Spend: ${stats.spendCents} cents`);
      return stats;
    } catch (err) {
      logger.error("Failed to query Meta Marketing campaign performance metrics", err);
      throw err;
    }
  },

  /* ─── Hierarchy path: real Campaign -> Ad Set -> Creative -> Ad object graph ─── */

  async createCampaignContainer(input: CampaignContainerInput, explicit?: MetaCredentials): Promise<{ externalId: string }> {
    const credentials = resolveCredentials(explicit);
    if (!credentials) return { externalId: mockId("meta_campaign") };

    // CBO (Campaign Budget Optimization / "Advantage Campaign Budget"): the daily budget + bid
    // strategy live on the CAMPAIGN and Meta distributes spend across ad sets. Default ABO keeps
    // budgets on each ad set (see createAdSetContainer.daily_budget) and campaign budget sharing off.
    const cbo = input.budgetMode === "CBO" && !!input.dailyBudgetCents;
    const campaignBody: Record<string, unknown> = {
      name: clampName(input.name),
      objective: input.objective,
      status: "PAUSED",
      special_ad_categories: [],
      // Meta REQUIRES this flag be set explicitly (Graph API error subcode 4834011 otherwise).
      // CBO true = a single campaign budget shared across ad sets; ABO false = each ad set owns its budget.
      is_adset_budget_sharing_enabled: cbo,
    };
    if (cbo) {
      campaignBody.daily_budget = toMetaMinorUnits(floorAdSetBudgetCents(input.dailyBudgetCents!, credentials.currency), credentials.currency);
      // Same "Lowest Cost, no bid cap" default the ad-set path uses — required at campaign level for CBO.
      campaignBody.bid_strategy = "LOWEST_COST_WITHOUT_CAP";
    }
    const json = await graphPost(`/act_${credentials.adAccountId}/campaigns`, credentials.accessToken, campaignBody);
    if (!json?.id) throw new Error(`Meta campaign creation failed: ${JSON.stringify(json)}`);
    return { externalId: json.id };
  },

  async createAdSetContainer(input: AdSetContainerInput, explicit?: MetaCredentials): Promise<{ externalId: string }> {
    const credentials = resolveCredentials(explicit);
    if (!credentials) return { externalId: mockId("meta_adset") };

    // Under CBO the budget + bid strategy live on the campaign, so the ad set must OMIT both —
    // sending daily_budget/bid_strategy on an ad set of a CBO campaign is rejected by Meta.
    const cbo = input.budgetMode === "CBO";
    const body: Record<string, unknown> = {
      name: clampName(input.name),
      campaign_id: input.campaignExternalId,
      billing_event: "IMPRESSIONS",
      // Meta requires OFFSITE_CONVERSIONS (not LINK_CLICKS) whenever a promoted_object/pixel is set.
      optimization_goal: input.promotedObject ? "OFFSITE_CONVERSIONS" : (input.objective ? resolveOptimizationGoal(input.objective as any, false) : "LINK_CLICKS"),
      targeting: input.targeting,
      status: "PAUSED",
    };
    if (!cbo) {
      body.daily_budget = toMetaMinorUnits(floorAdSetBudgetCents(input.dailyBudgetCents, credentials.currency), credentials.currency);
      // With ABO (ad-set budgets) and no campaign bid_strategy, Meta otherwise defaults to a
      // strategy that demands a bid cap / ROAS floor and rejects the ad set (subcode 2490487).
      // LOWEST_COST_WITHOUT_CAP is the "Lowest Cost" strategy that needs no bid amount — the same
      // default the native Meta wizard uses. A caller-supplied cap could switch this later.
      body.bid_strategy = "LOWEST_COST_WITHOUT_CAP";
    }
    if (input.promotedObject) body.promoted_object = { pixel_id: input.promotedObject.pixelId, custom_event_type: input.promotedObject.customEventType };
    if (input.startTime) body.start_time = input.startTime;
    if (input.endTime) body.end_time = input.endTime;
    if (input.advantagePlus) body.targeting_automation = { advantage_audience: 1 };
    if (input.frequencyCap) {
      body.frequency_control_specs = [{
        event: "IMPRESSIONS",
        interval_days: input.frequencyCap.intervalDays,
        max_frequency: input.frequencyCap.maxImpressions,
      }];
    }

    const json = await graphPost(`/act_${credentials.adAccountId}/adsets`, credentials.accessToken, body);
    if (!json?.id) throw new Error(`Meta ad set creation failed: ${JSON.stringify(json)}`);
    return { externalId: json.id };
  },

  async uploadCreativeAsset(input: CreativeUploadInput, explicit?: MetaCredentials): Promise<CreativeUploadResult> {
    const credentials = resolveCredentials(explicit);
    if (!credentials) return input.videoUrl ? { videoId: mockId("meta_video") } : { imageHash: mockId("meta_imghash") };

    if (input.videoUrl) {
      const json = await graphPost(`/act_${credentials.adAccountId}/advideos`, credentials.accessToken, {
        file_url: input.videoUrl,
      });
      if (!json?.id) throw new Error(`Meta video upload failed: ${JSON.stringify(json)}`);
      await waitForVideoProcessing(json.id, credentials.accessToken);
      return { videoId: json.id };
    }

    // Prefer raw bytes when provided (an SVG/local creative the launch path rasterized to PNG):
    // Meta can't fetch a localhost/relative URL and rejects SVG, so we POST the PNG bytes to
    // /adimages via the `bytes` field instead of a `url`.
    if (input.imageBytesBase64 || input.imageUrl) {
      const body = input.imageBytesBase64 ? { bytes: input.imageBytesBase64 } : { url: input.imageUrl };
      const json = await graphPost(`/act_${credentials.adAccountId}/adimages`, credentials.accessToken, body);
      const firstImage = json?.images ? Object.values(json.images)[0] as { hash?: string } | undefined : undefined;
      if (!firstImage?.hash) throw new Error(`Meta image upload failed: ${JSON.stringify(json)}`);
      return { imageHash: firstImage.hash };
    }

    // No image/video on this creative. This is NOT survivable: Meta requires a visual on a
    // link/video ad and rejects the creative with a misleading "Invalid image format ... we could
    // not process the image that you have uploaded" (code 100 / subcode 2446496) — an error that
    // names an upload nobody made, which is why this cost real debugging time. Fail here with an
    // accurate, actionable message instead, so it surfaces as the variant's failureReason.
    // (An earlier comment claimed the ad "still gets created" without a hash. It does not.)
    const noCreativeMessage = "This ad has no image or video. Upload a creative image for this ad before publishing.";
    throw new MetaGraphError({
      message: `Meta creative upload skipped: ${noCreativeMessage}`,
      // 422, not 400: this never reached Meta — it's our own pre-flight rejection. Keeping it out
      // of the 4xx-from-Graph space also keeps fetchWithRetry's retry classification honest.
      httpStatus: 422,
      userMessage: noCreativeMessage,
      isAuthError: false,
      isRateLimit: false,
    });
  },

  async createHierarchyAd(input: HierarchyAdInput, explicit?: MetaCredentials): Promise<LaunchVariantResult> {
    const credentials = resolveCredentials(explicit);
    if (!credentials) return { externalId: mockId("meta_ad"), status: "paused" };
    // Non-null local so the nested createCreative closure keeps the narrowing (TS widens `credentials`
    // back to nullable inside a closure).
    const creds = credentials;

    const ctaType = toMetaCtaType(input.creative.callToAction);
    const linkData: Record<string, unknown> = {
      message: input.creative.body,
      link: input.landingPageUrl,
      name: input.creative.headline,
      call_to_action: { type: ctaType, value: { link: input.landingPageUrl } },
    };
    if (input.imageHash) linkData.image_hash = input.imageHash;

    const baseStorySpec: Record<string, unknown> = { page_id: credentials.pageId };
    if (input.videoId) {
      baseStorySpec.video_data = {
        video_id: input.videoId,
        message: input.creative.body,
        call_to_action: { type: ctaType, value: { link: input.landingPageUrl } },
      };
    } else {
      baseStorySpec.link_data = linkData;
    }

    // Attach the Instagram actor when provided, but don't let a STALE/invalid IG id hard-fail the
    // whole ad ("(#100) Param instagram_actor_id must be a valid Instagram account id"): if the
    // creative call fails specifically on instagram_actor_id, retry Page-only (the ad still ships to
    // the Facebook Page placement, just not the IG account). A valid IG id publishes to both.
    async function createCreative(withIg: boolean): Promise<any> {
      const spec = withIg && input.instagramActorId ? { ...baseStorySpec, instagram_actor_id: input.instagramActorId } : baseStorySpec;
      return graphPost(`/act_${creds.adAccountId}/adcreatives`, creds.accessToken, {
        name: clampName(`${input.name}-creative`),
        object_story_spec: spec,
      });
    }
    let creativeJson;
    try {
      creativeJson = await createCreative(true);
      if (!creativeJson?.id) throw new Error(`Meta ad creative creation failed: ${JSON.stringify(creativeJson)}`);
    } catch (err) {
      if (input.instagramActorId && /instagram_actor_id/i.test(err instanceof Error ? err.message : String(err))) {
        logger.warn(`createHierarchyAd: instagram_actor_id ${input.instagramActorId} rejected by Meta — retrying Page-only`);
        creativeJson = await createCreative(false);
        if (!creativeJson?.id) throw new Error(`Meta ad creative creation failed: ${JSON.stringify(creativeJson)}`);
      } else {
        throw err;
      }
    }

    const adJson = await graphPost(`/act_${credentials.adAccountId}/ads`, credentials.accessToken, {
      name: clampName(input.name),
      adset_id: input.adSetExternalId,
      creative: { creative_id: creativeJson.id },
      status: "PAUSED",
    });
    if (!adJson?.id) throw new Error(`Meta ad creation failed: ${JSON.stringify(adJson)}`);

    return { externalId: adJson.id, status: "paused" };
  },
};
