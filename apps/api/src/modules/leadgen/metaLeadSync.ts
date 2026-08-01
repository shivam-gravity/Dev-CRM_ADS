import { prisma } from "../../db/prisma.js";
import { logger } from "../logger/logger.js";
import { getMetaCredentials } from "../integrations/integrationService.js";
import { ingestLead, upsertLeadForm, type LeadRecord } from "./leadIngestionService.js";

const GRAPH_VERSION = "v22.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

async function graphGet(path: string, params: Record<string, string>): Promise<any> {
  const url = `${GRAPH_BASE}${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url);
  const json = (await res.json()) as any;
  if (!res.ok || json.error) {
    throw new Error(`Meta Graph API error on ${path}: ${json.error?.error_user_msg ?? json.error?.message ?? res.status}`);
  }
  return json;
}

/** Field-data array from Meta (`[{ name, values: [value] }]`) flattened into a `{FIELD_NAME: value}` map matching the CRM's expected `field_data` shape. */
function flattenFieldData(fieldData: Array<{ name: string; values?: string[] }> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fieldData ?? []) {
    if (f.values && f.values.length > 0) out[f.name.toUpperCase()] = f.values[0];
  }
  return out;
}

function pick(fields: Record<string, string>, ...keys: string[]): string | null {
  for (const k of keys) if (fields[k]) return fields[k];
  return null;
}

/**
 * Resolves the workspace a Meta leadgen webhook event belongs to, by matching the
 * event's page_id against a connected Meta Integration's stored settings.pageId.
 */
export async function resolveWorkspaceIdForMetaPage(pageId: string): Promise<string | null> {
  const rows = await prisma.integration.findMany({ where: { platform: "meta" } });
  for (const row of rows) {
    const data = row.data as any;
    if (data?.settings?.pageId === pageId && data?.status === "connected") return row.workspaceId;
  }
  return null;
}

/** Fetches one lead's field_data from Meta and upserts it — shared by the webhook worker and the backfill job. */
export async function ingestMetaLead(workspaceId: string, leadgenId: string): Promise<LeadRecord | null> {
  const credentials = await getMetaCredentials(workspaceId);
  if (!credentials) {
    logger.warn(`ingestMetaLead: workspace ${workspaceId} has no connected Meta credentials — skipping ${leadgenId}`);
    return null;
  }

  // Lead retrieval is a Page-permission-gated endpoint — prefer the Page token when one
  // was provided (manual connect or a future Page-token OAuth step), since the ad-account
  // token alone may lack leads_retrieval on the Page.
  const json = await graphGet(`/${leadgenId}`, {
    fields: "field_data,ad_id,form_id,created_time",
    access_token: credentials.pageAccessToken ?? credentials.accessToken,
  });

  const fields = flattenFieldData(json.field_data);
  return ingestLead({
    workspaceId,
    platform: "meta",
    externalId: leadgenId,
    formExternalId: json.form_id ?? null,
    adId: json.ad_id ?? null,
    fullName: pick(fields, "FULL_NAME", "FIRST_NAME"),
    email: pick(fields, "EMAIL", "WORK_EMAIL"),
    phone: pick(fields, "PHONE_NUMBER", "WORK_PHONE"),
    companyName: pick(fields, "COMPANY_NAME"),
    submittedAt: json.created_time ? new Date(json.created_time) : new Date(),
    data: fields,
  });
}

async function syncOneMetaForm(workspaceId: string, accessToken: string, form: { id: string; name: string; status?: string; questions?: unknown }): Promise<number> {
  await upsertLeadForm({
    workspaceId,
    platform: "meta",
    externalId: form.id,
    name: form.name,
    data: form as Record<string, unknown>,
  });

  let count = 0;
  let after: string | undefined;
  do {
    const json: any = await graphGet(`/${form.id}/leads`, {
      fields: "field_data,ad_id,created_time",
      limit: "100",
      access_token: accessToken,
      ...(after ? { after } : {}),
    });
    for (const lead of json.data ?? []) {
      const fields = flattenFieldData(lead.field_data);
      await ingestLead({
        workspaceId,
        platform: "meta",
        externalId: lead.id,
        formExternalId: form.id,
        adId: lead.ad_id ?? null,
        fullName: pick(fields, "FULL_NAME", "FIRST_NAME"),
        email: pick(fields, "EMAIL", "WORK_EMAIL"),
        phone: pick(fields, "PHONE_NUMBER", "WORK_PHONE"),
        companyName: pick(fields, "COMPANY_NAME"),
        submittedAt: lead.created_time ? new Date(lead.created_time) : new Date(),
        data: fields,
      });
      count++;
    }
    after = json.paging?.cursors?.after && json.data?.length ? json.paging.cursors.after : undefined;
  } while (after);

  return count;
}

/** Backfills every lead form + lead on the connected Meta Page — used by the manual "Sync Recent Leads" trigger. */
export interface MetaLeadFormOption {
  id: string;
  name: string;
  status?: string;
}

/**
 * The Page's instant (lead-gen) forms, for the campaign builder's form picker.
 *
 * Reading forms is not new — backfillMetaLeads below has always listed them to pull historical
 * leads. What was missing was any way to ATTACH one to an ad we publish, so a Leads campaign always
 * had to drive to the website and optimise for a pixel conversion. On a small budget that is the
 * most expensive possible way to buy a lead.
 *
 * Uses the PAGE token: /{pageId}/leadgen_forms is Page-permission-gated and an ad-account token is
 * rejected. Returns [] rather than throwing when Meta or the Page is not connected — an empty
 * picker is a correct answer, not an error.
 */
export async function listMetaLeadForms(workspaceId: string): Promise<MetaLeadFormOption[]> {
  const credentials = await getMetaCredentials(workspaceId);
  if (!credentials?.pageId) return [];
  const pageToken = credentials.pageAccessToken ?? credentials.accessToken;
  try {
    const json: any = await graphGet(`/${credentials.pageId}/leadgen_forms`, {
      fields: "id,name,status",
      access_token: pageToken,
    });
    return (json.data ?? [])
      .filter((f: any) => f?.id)
      // ARCHIVED/DRAFT forms cannot receive leads, so offering one would publish an ad that collects
      // nothing. Meta reports active forms as "ACTIVE"; keep anything unlabelled rather than guess.
      .filter((f: any) => !f.status || String(f.status).toUpperCase() === "ACTIVE")
      .map((f: any) => ({ id: String(f.id), name: f.name ?? `Form ${f.id}`, status: f.status }));
  } catch (err) {
    logger.warn(`listMetaLeadForms: could not list lead forms for workspace ${workspaceId}`, err);
    return [];
  }
}

export async function backfillMetaLeads(workspaceId: string): Promise<{ formsSynced: number; leadsSynced: number }> {
  const credentials = await getMetaCredentials(workspaceId);
  if (!credentials?.pageId) {
    throw new Error("Meta is not connected (or no Page is linked) for this workspace");
  }

  const pageToken = credentials.pageAccessToken ?? credentials.accessToken;
  const formsJson: any = await graphGet(`/${credentials.pageId}/leadgen_forms`, {
    fields: "id,name,status,questions",
    access_token: pageToken,
  });
  const forms = formsJson.data ?? [];

  let leadsSynced = 0;
  for (const form of forms) {
    leadsSynced += await syncOneMetaForm(workspaceId, pageToken, form);
  }

  return { formsSynced: forms.length, leadsSynced };
}
