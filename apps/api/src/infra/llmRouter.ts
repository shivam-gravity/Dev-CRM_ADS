import { logger } from "../modules/logger/logger.js";
import * as geminiClient from "./geminiClient.js";
import type { ChatMessage, JsonSchemaTool } from "./llmTypes.js";
import { assertGlobalLlmUsageAvailable } from "./llmUsageBoundary.js";
import { withLlmUsageContext } from "./llmUsageContext.js";

/**
 * Single-provider dispatch: the whole pipeline depends FULLY on Google Gemini. Callers
 * (agents/support.ts, research/providers/support.ts, research/decision/support.ts) never import
 * geminiClient directly; they resolve an LLMAssignment via llmTaskConfig.ts and call this.
 *
 * There is no multi-provider fallback chain. That is a deliberate simplification, but it puts the
 * whole burden of surviving Gemini's PER-MINUTE rate limits on geminiClient's concurrency limiter
 * + 429-backoff — a task either eventually succeeds there or returns null here. Callers must keep
 * treating null as "this leg produced nothing" rather than assuming a retry happens above.
 */

export type LLMProvider = "gemini";
export interface LLMAssignment {
  provider: LLMProvider;
  model: string;
  /**
   * Registered task name this assignment was resolved for (llmTaskConfig.resolveTaskModel sets it).
   *
   * Carried on the ASSIGNMENT rather than added as a parameter because every one of the ~68 tasks
   * already resolves through resolveTaskModel — so token usage becomes attributable per task with
   * no change at any call site.
   */
  task?: string;
}

interface StructuredOpts {
  maxTokens: number;
  system?: string;
  messages: ChatMessage[];
  tool: JsonSchemaTool;
}

interface TextOpts {
  maxTokens: number;
  system?: string;
  messages: ChatMessage[];
}

/** `source` reports which provider produced `data`. With a single backend it is always "gemini",
 * but the field is kept so callers (callAgentModel, webSearchThenStructure, callDecisionModel) can
 * keep surfacing provenance on their own result types unchanged. */
export interface RunResult<T> {
  data: T | null;
  source: LLMProvider;
}

export async function runStructured<T>(assignment: LLMAssignment, opts: StructuredOpts): Promise<RunResult<T>> {
  // Checked before dispatch — see llmUsageBoundary.ts for why this is a hard stop.
  assertGlobalLlmUsageAvailable();
  try {
    const data = await withLlmUsageContext({ task: assignment.task }, () =>
      geminiClient.runStructured<T>({ ...opts, model: assignment.model })
    );
    return { data, source: "gemini" };
  } catch (err) {
    logger.warn(`llmRouter: gemini:${assignment.model} structured call failed`, err);
    return { data: null, source: "gemini" };
  }
}

export async function runText(assignment: LLMAssignment, opts: TextOpts): Promise<RunResult<string>> {
  assertGlobalLlmUsageAvailable();
  try {
    const data = await withLlmUsageContext({ task: assignment.task }, () =>
      geminiClient.runText({ ...opts, model: assignment.model })
    );
    return { data, source: "gemini" };
  } catch (err) {
    logger.warn(`llmRouter: gemini:${assignment.model} text call failed`, err);
    return { data: null, source: "gemini" };
  }
}
