import { randomUUID } from "node:crypto";
import { prisma } from "../../db/prisma.js";

export type GenerationJobType = "image" | "video" | "full_creative";
export type GenerationJobStatus = "queued" | "running" | "done" | "failed";

export interface GenerationJobInput {
  businessId: string;
  productUrl?: string;
  prompt?: string;
  wantVideo: boolean;
  aspectRatio?: "square" | "portrait" | "landscape";
  language?: string;
  quality?: "standard" | "high";
  /** How many DISTINCT angle-diverse creatives to produce in one job (each its own hook +
   * image), so a campaign has real arms for the optimization bandit to test instead of one
   * near-duplicate. Only honored on the standalone "initial" image path — a fatigue-refresh
   * wants exactly one replacement, and a video job stays single (Runway per-clip cost). Clamped
   * to [1, MAX_CREATIVE_VARIANTS]; defaults to DEFAULT_CREATIVE_VARIANTS when unset. */
  variantCount?: number;
  /** Set when this job was triggered automatically for a specific live campaign variant
   * (e.g. a fatigue-triggered refresh) rather than a standalone "generate a creative"
   * request — lets callers trace the new creative back to what it's meant to replace. */
  campaignId?: string;
  variantId?: string;
  /** "fatigue-refresh" distinguishes an automated regeneration from a normal user-initiated
   * "initial" generation — see creativeFatigueDetector.ts, the only current writer of this. */
  reason?: "initial" | "fatigue-refresh";
}

/** One creative in a multi-angle generation burst. The job's top-level result fields mirror
 * the FIRST of these (backward compat); the full set — including the primary at index 0 —
 * lives in GenerationJobResult.variants so callers can surface/launch every angle. */
export interface GenerationCreativeVariant {
  creativeId: string;
  headline: string;
  body: string;
  callToAction: string;
  /** The distinct persuasion/creative angle this concept uses (e.g. "social proof", "urgency"). */
  angle?: string;
  imageAssetId: string;
  imageUrl: string;
  videoAssetId?: string;
  videoUrl?: string;
}

export interface GenerationJobResult {
  headline: string;
  body: string;
  callToAction: string;
  creativeId: string;
  imageAssetId: string;
  imageUrl: string;
  videoAssetId?: string;
  videoUrl?: string;
  /** The full multi-angle burst (present when the job produced more than one creative). Index 0
   * is the same creative the top-level fields describe, so single-creative consumers (fatigue
   * swap, existing UI) keep working off the top-level fields and ignore this. */
  variants?: GenerationCreativeVariant[];
}

export interface GenerationJob {
  id: string;
  workspaceId: string;
  businessId: string;
  type: GenerationJobType;
  status: GenerationJobStatus;
  input: GenerationJobInput;
  result?: GenerationJobResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

function fromRow(row: { id: string; workspaceId: string; businessId: string; type: string; status: string; input: unknown; result: unknown; error: string | null; createdAt: Date; updatedAt: Date }): GenerationJob {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    businessId: row.businessId,
    type: row.type as GenerationJobType,
    status: row.status as GenerationJobStatus,
    input: row.input as unknown as GenerationJobInput,
    result: (row.result as unknown as GenerationJobResult) ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createGenerationJob(workspaceId: string, input: GenerationJobInput): Promise<GenerationJob> {
  const row = await prisma.generationJob.create({
    data: {
      id: randomUUID(),
      workspaceId,
      businessId: input.businessId,
      type: input.wantVideo ? "full_creative" : "image",
      status: "queued",
      input: input as any,
    },
  });
  return fromRow(row);
}

export async function getGenerationJob(id: string): Promise<GenerationJob | null> {
  const row = await prisma.generationJob.findUnique({ where: { id } });
  return row ? fromRow(row) : null;
}

/**
 * Used by creativeFatigueDetector.ts as a cooldown check — before enqueuing a new
 * fatigue-triggered refresh for a variant, confirm one wasn't already triggered recently, so
 * a variant that stays fatigued across several 15-minute optimization ticks doesn't get a
 * new regeneration job every tick. `input` is stored as an opaque JSON blob (same convention
 * as every other JSON-backed model in this codebase — see Integration/Campaign), so the
 * variantId/reason filter happens in application code after a narrower businessId+date scan,
 * not as a database-level JSON query.
 */
export async function hasRecentFatigueRefresh(businessId: string, variantId: string, sinceIso: string): Promise<boolean> {
  const rows = await prisma.generationJob.findMany({
    where: { businessId, createdAt: { gte: new Date(sinceIso) } },
  });
  return rows.some((r) => {
    const input = r.input as unknown as GenerationJobInput;
    return input.variantId === variantId && input.reason === "fatigue-refresh";
  });
}

export async function markGenerationJobRunning(id: string): Promise<void> {
  await prisma.generationJob.update({ where: { id }, data: { status: "running" } });
}

export async function markGenerationJobDone(id: string, result: GenerationJobResult): Promise<void> {
  await prisma.generationJob.update({ where: { id }, data: { status: "done", result: result as any } });
}

export async function markGenerationJobFailed(id: string, error: string): Promise<void> {
  await prisma.generationJob.update({ where: { id }, data: { status: "failed", error } });
}
