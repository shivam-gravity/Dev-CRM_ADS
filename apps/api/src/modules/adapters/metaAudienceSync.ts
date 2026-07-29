import { createHash } from "node:crypto";
import type { MetaCredentials } from "./AdAdapter.js";
import { logger } from "../logger/logger.js";

const GRAPH_VERSION = "v22.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const ENV_META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const ENV_META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;
const hasLiveCredentials = Boolean(ENV_META_ACCESS_TOKEN && ENV_META_AD_ACCOUNT_ID);

function mockId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Three-tier fallback: explicit per-workspace OAuth credentials > global env-var
 * credentials (legacy single-tenant/local) > null (mock mode).
 */
function resolveCredentials(explicit?: MetaCredentials): MetaCredentials | null {
  if (explicit) return explicit;
  if (hasLiveCredentials) return { accessToken: ENV_META_ACCESS_TOKEN!, adAccountId: ENV_META_AD_ACCOUNT_ID!, currency: "USD" };
  return null;
}

// Exponential Backoff Retry Helper
async function fetchWithRetry(url: string, options: RequestInit, retries = 3, delay = 500): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      logger.info(`Sending Request: ${options.method || "GET"} ${url.split("?")[0]} (Attempt ${i + 1}/${retries})`);
      const res = await fetch(url, options);
      if (res.ok) {
        return res;
      }
      logger.warn(`Meta Audience API returned status ${res.status}. Attempt ${i + 1} failed.`);
      if (i === retries - 1) {
        throw new Error(`Meta API returned ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      logger.error(`Network Exception on Meta Audience fetch attempt ${i + 1}`, err);
      if (i === retries - 1) throw err;
    }
    await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
  }
  throw new Error("Meta Audience HTTP request failed after maximum retries");
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

async function graphGet(path: string, accessToken: string): Promise<any> {
  const url = `${GRAPH_BASE}${path}${path.includes("?") ? "&" : "?"}access_token=${accessToken}`;
  const res = await fetchWithRetry(url, { method: "GET" });
  return res.json();
}

async function graphDelete(path: string, accessToken: string): Promise<any> {
  const url = `${GRAPH_BASE}${path}?access_token=${accessToken}`;
  const res = await fetchWithRetry(url, { method: "DELETE" });
  return res.json();
}

/* ─── SHA256 hashing for PII normalization (Meta requirement) ─── */

function sha256(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

/* ─── Input / Output Types ─── */

export type CustomAudienceSubtype = "CUSTOM" | "WEBSITE" | "APP" | "OFFLINE" | "ENGAGEMENT";

export interface CreateCustomAudienceInput {
  adAccountId: string;
  name: string;
  description?: string;
  subtype: CustomAudienceSubtype;
  customerFileSource?: string;
}

export interface CreateLookalikeAudienceInput {
  adAccountId: string;
  name: string;
  /** The source Custom Audience external ID to base the Lookalike on. */
  originAudienceId: string;
  /** Target countries for the Lookalike (ISO 2-letter codes, e.g. ["US", "GB"]). */
  targetCountries: string[];
  /** Lookalike ratio (0.01 to 0.20 — 1% to 20% of country population). */
  ratio: number;
}

export interface AddUsersInput {
  emails?: string[];
  phones?: string[];
}

export interface AudienceSyncResult {
  externalId: string;
  approximateCount?: number;
}

export interface AddUsersResult {
  numReceived: number;
  numInvalid: number;
}

export interface AudienceSizeResult {
  approximateCount: number;
  deliveryStatus?: string;
}

/* ─── Audience Sync Functions ─── */

/**
 * Creates a Custom Audience in Meta.
 * POST /act_{adAccountId}/customaudiences
 */
export async function createCustomAudience(
  input: CreateCustomAudienceInput,
  credentials?: MetaCredentials,
): Promise<AudienceSyncResult> {
  const creds = resolveCredentials(credentials);

  if (!creds) {
    logger.info("No credentials available. Returning mock Custom Audience ID.");
    return { externalId: mockId("meta_audience"), approximateCount: 0 };
  }

  // Strip any existing "act_" prefix — the URL template re-adds it, so a stored "act_773…" must not
  // become "act_act_773…" (Graph 400, subcode 33). Mirrors metaAdapter's bare-id handling.
  const accountId = String(input.adAccountId || creds.adAccountId).replace(/^act_/, "");

  const body: Record<string, unknown> = {
    name: input.name,
    subtype: input.subtype,
  };
  if (input.description) body.description = input.description;
  if (input.customerFileSource) body.customer_file_source = input.customerFileSource;

  logger.info(`Creating Custom Audience "${input.name}" (subtype=${input.subtype}) on account ${accountId}`);

  const json = await graphPost(`/act_${accountId}/customaudiences`, creds.accessToken, body);
  if (!json?.id) throw new Error(`Meta Custom Audience creation failed: ${JSON.stringify(json)}`);

  logger.info(`Custom Audience created: ${json.id}`);
  return { externalId: json.id, approximateCount: json.approximate_count ?? undefined };
}

/**
 * Creates a Lookalike Audience from an existing source Custom Audience in Meta.
 * POST /act_{adAccountId}/customaudiences with lookalike_spec
 */
export async function createLookalikeAudience(
  input: CreateLookalikeAudienceInput,
  credentials?: MetaCredentials,
): Promise<AudienceSyncResult> {
  const creds = resolveCredentials(credentials);

  if (!creds) {
    logger.info("No credentials available. Returning mock Lookalike Audience ID.");
    return { externalId: mockId("meta_audience"), approximateCount: 0 };
  }

  // Strip any existing "act_" prefix — the URL template re-adds it, so a stored "act_773…" must not
  // become "act_act_773…" (Graph 400, subcode 33). Mirrors metaAdapter's bare-id handling.
  const accountId = String(input.adAccountId || creds.adAccountId).replace(/^act_/, "");

  // Clamp ratio to Meta's accepted range
  const ratio = Math.max(0.01, Math.min(0.20, input.ratio));

  const body: Record<string, unknown> = {
    name: input.name,
    subtype: "LOOKALIKE",
    // The source Custom Audience id goes in the top-level origin_audience_id param — NOT inside
    // lookalike_spec (Graph errors #2654 "No custom_audience ID given" otherwise). lookalike_spec
    // then only carries the ratio + target country/countries.
    origin_audience_id: input.originAudienceId,
    lookalike_spec: JSON.stringify({
      type: "similarity",
      country: input.targetCountries[0] ?? "US",
      target_countries: input.targetCountries,
      ratio,
    }),
  };

  logger.info(`Creating Lookalike Audience "${input.name}" from source ${input.originAudienceId} (ratio=${ratio}, countries=${input.targetCountries.join(",")})`);

  const json = await graphPost(`/act_${accountId}/customaudiences`, creds.accessToken, body);
  if (!json?.id) throw new Error(`Meta Lookalike Audience creation failed: ${JSON.stringify(json)}`);

  logger.info(`Lookalike Audience created: ${json.id}`);
  return { externalId: json.id, approximateCount: json.approximate_count ?? undefined };
}

/**
 * Adds hashed user data to an existing Custom Audience.
 * POST /{audienceExternalId}/users
 *
 * Meta requires all PII (emails, phones) to be SHA256-hashed before upload.
 */
export async function addUsersToCustomAudience(
  audienceExternalId: string,
  users: AddUsersInput,
  credentials?: MetaCredentials,
): Promise<AddUsersResult> {
  const creds = resolveCredentials(credentials);

  if (!creds) {
    const total = (users.emails?.length ?? 0) + (users.phones?.length ?? 0);
    logger.info(`No credentials available. Mock adding ${total} users to audience ${audienceExternalId}.`);
    return { numReceived: total, numInvalid: 0 };
  }

  // Build the schema and data arrays per Meta's multi-key match format
  const schema: string[] = [];
  const data: string[][] = [];

  const emails = users.emails ?? [];
  const phones = users.phones ?? [];

  if (emails.length > 0 && phones.length > 0) {
    // Multi-key: each row is [hashedEmail, hashedPhone]
    schema.push("EMAIL", "PHONE");
    const maxLen = Math.max(emails.length, phones.length);
    for (let i = 0; i < maxLen; i++) {
      const row: string[] = [
        i < emails.length ? sha256(emails[i]) : "",
        i < phones.length ? sha256(phones[i]) : "",
      ];
      data.push(row);
    }
  } else if (emails.length > 0) {
    schema.push("EMAIL");
    for (const email of emails) {
      data.push([sha256(email)]);
    }
  } else if (phones.length > 0) {
    schema.push("PHONE");
    for (const phone of phones) {
      data.push([sha256(phone)]);
    }
  }

  if (data.length === 0) {
    logger.warn("addUsersToCustomAudience called with no user data.");
    return { numReceived: 0, numInvalid: 0 };
  }

  logger.info(`Adding ${data.length} hashed user rows to Custom Audience ${audienceExternalId}`);

  const payload: Record<string, unknown> = {
    payload: {
      schema,
      data,
    },
  };

  const json = await graphPost(`/${audienceExternalId}/users`, creds.accessToken, payload);

  const numReceived = json?.num_received ?? data.length;
  const numInvalid = json?.num_invalid_entries ?? 0;

  logger.info(`Users added to ${audienceExternalId}: received=${numReceived}, invalid=${numInvalid}`);
  return { numReceived, numInvalid };
}

/**
 * Deletes a Custom Audience from Meta.
 * DELETE /{audienceExternalId}
 */
export async function deleteCustomAudience(
  audienceExternalId: string,
  credentials?: MetaCredentials,
): Promise<void> {
  const creds = resolveCredentials(credentials);

  if (!creds) {
    logger.info(`No credentials available. Mock deleting audience ${audienceExternalId}.`);
    return;
  }

  logger.info(`Deleting Custom Audience ${audienceExternalId}`);
  const json = await graphDelete(`/${audienceExternalId}`, creds.accessToken);

  if (json?.success === false) {
    throw new Error(`Meta audience deletion failed: ${JSON.stringify(json)}`);
  }

  logger.info(`Custom Audience ${audienceExternalId} deleted successfully.`);
}

/**
 * Fetches approximate audience size and delivery status for a Custom/Lookalike Audience.
 * GET /{audienceExternalId}?fields=approximate_count,delivery_status
 */
export async function getAudienceSize(
  audienceExternalId: string,
  credentials?: MetaCredentials,
): Promise<AudienceSizeResult> {
  const creds = resolveCredentials(credentials);

  if (!creds) {
    // No connected Meta account → audience size is genuinely unknown. Return 0 / "not_connected"
    // rather than a Math.random() fabricated reach the UI would show as a real estimate.
    logger.info(`No credentials available. Audience size unknown for ${audienceExternalId} (not connected).`);
    return { approximateCount: 0, deliveryStatus: "not_connected" };
  }

  logger.info(`Fetching audience size for ${audienceExternalId}`);
  const json = await graphGet(`/${audienceExternalId}?fields=approximate_count,delivery_status`, creds.accessToken);

  const approximateCount = Number(json?.approximate_count ?? 0);
  const deliveryStatus = json?.delivery_status?.status;

  logger.info(`Audience ${audienceExternalId} size: ~${approximateCount}, delivery: ${deliveryStatus ?? "unknown"}`);
  return { approximateCount, deliveryStatus };
}
