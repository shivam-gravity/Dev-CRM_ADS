import { randomUUID } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import type { AgentResult } from "../../agents/types/index.js";
import type { DecisionContext } from "../../research/decision/types.js";

/**
 * pending -> researching -> aggregating -> running_agents -> building_campaign ->
 * completed | failed. Mirrors ResearchJobStatus's shape but spans the whole
 * Gateway -> Campaign Route -> Research Orchestrator -> Knowledge Aggregator -> AI
 * Agent Coordinator -> Campaign Builder pipeline, not just the research phase.
 */
export type CampaignGenerationStatus =
  | "pending"
  | "researching"
  | "aggregating"
  | "running_agents"
  | "building_campaign"
  | "completed"
  | "failed";

export interface CampaignGenerationJobRecord {
  id: string;
  workspaceId: string;
  businessId: string;
  url: string;
  name?: string;
  dailyBudgetCents?: number;
  status: CampaignGenerationStatus;
  researchJobId?: string;
  strategyId?: string;
  campaignId?: string;
  agentResults: Record<string, AgentResult<unknown>> | null;
  /** Populated as soon as the research phase completes, well before agentResults/campaignId —
   * see research/decision/decision-engine.ts. Null until ready, or if it failed (best-effort). */
  decisionContext: DecisionContext | null;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

function fromRow(row: {
  id: string; workspaceId: string; businessId: string; url: string; name: string | null;
  dailyBudgetCents: number | null; status: string; researchJobId: string | null;
  strategyId: string | null; campaignId: string | null; agentResults: unknown;
  decisionContext: unknown;
  error: string | null; startedAt: Date | null; completedAt: Date | null;
  createdAt: Date; updatedAt: Date;
}): CampaignGenerationJobRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    businessId: row.businessId,
    url: row.url,
    name: row.name ?? undefined,
    dailyBudgetCents: row.dailyBudgetCents ?? undefined,
    status: row.status as CampaignGenerationStatus,
    researchJobId: row.researchJobId ?? undefined,
    strategyId: row.strategyId ?? undefined,
    campaignId: row.campaignId ?? undefined,
    agentResults: (row.agentResults as Record<string, AgentResult<unknown>> | null) ?? null,
    decisionContext: (row.decisionContext as DecisionContext | null) ?? null,
    error: row.error ?? undefined,
    startedAt: row.startedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createCampaignGenerationJob(input: {
  workspaceId: string;
  businessId: string;
  url: string;
  name?: string;
  dailyBudgetCents?: number;
}): Promise<CampaignGenerationJobRecord> {
  const row = await prisma.campaignGenerationJob.create({
    data: {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      businessId: input.businessId,
      url: input.url,
      name: input.name,
      dailyBudgetCents: input.dailyBudgetCents,
      status: "pending",
    },
  });
  return fromRow(row);
}

export async function getCampaignGenerationJob(id: string): Promise<CampaignGenerationJobRecord | null> {
  const row = await prisma.campaignGenerationJob.findUnique({ where: { id } });
  return row ? fromRow(row) : null;
}

/** Traces a live Campaign back to the generation job (and its DecisionContext — the
 * recommendations/strategies that produced it) it came from — the join point the
 * cross-campaign learning engine needs to attribute a real performance outcome back to
 * the recommendations responsible for it. Null for campaigns built outside this pipeline
 * (e.g. the manual builder flow), which have nothing to attribute outcomes to. */
export async function getCampaignGenerationJobByCampaignId(campaignId: string): Promise<CampaignGenerationJobRecord | null> {
  const row = await prisma.campaignGenerationJob.findFirst({ where: { campaignId }, orderBy: { completedAt: "desc" } });
  return row ? fromRow(row) : null;
}

export async function markCampaignGenerationStatus(
  id: string,
  status: CampaignGenerationStatus,
  extra?: { startedAt?: boolean; completedAt?: boolean; error?: string; researchJobId?: string; strategyId?: string; campaignId?: string }
): Promise<void> {
  await prisma.campaignGenerationJob.update({
    where: { id },
    data: {
      status,
      ...(extra?.startedAt ? { startedAt: new Date() } : {}),
      ...(extra?.completedAt ? { completedAt: new Date() } : {}),
      ...(extra?.error !== undefined ? { error: extra.error } : {}),
      ...(extra?.researchJobId !== undefined ? { researchJobId: extra.researchJobId } : {}),
      ...(extra?.strategyId !== undefined ? { strategyId: extra.strategyId } : {}),
      ...(extra?.campaignId !== undefined ? { campaignId: extra.campaignId } : {}),
    },
  });
}

export async function persistAgentResults(id: string, agentResults: Record<string, AgentResult<unknown>>): Promise<void> {
  await prisma.campaignGenerationJob.update({
    where: { id },
    data: { agentResults: agentResults as any },
  });
}

export async function persistDecisionContext(id: string, decisionContext: DecisionContext): Promise<void> {
  await prisma.campaignGenerationJob.update({
    where: { id },
    data: { decisionContext: decisionContext as any },
  });
}

/**
 * `campaignId` is null for a DEFERRED build: research + agents + strategy finished, but the ads
 * are not written until the user's Promotion Objective selections arrive (see the pipeline's
 * `deferBuild` and finishCampaignGenerationBuild). The job is genuinely complete at that point —
 * everything the results page renders comes from research — so it is "completed" without a campaign
 * rather than left in a running state that would poll forever.
 */
export async function markCampaignGenerationCompleted(id: string, campaignId: string | null): Promise<void> {
  await prisma.campaignGenerationJob.update({
    where: { id },
    data: { status: "completed", campaignId, completedAt: new Date() },
  });
}
