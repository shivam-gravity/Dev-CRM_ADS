import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Ambient attribution for LLM token usage: which TASK made a call, and which JOB it belongs to.
 *
 * WHY AsyncLocalStorage rather than parameters: token counts are only known deep inside
 * geminiClient (Gemini returns them on the response), while the task name is known in
 * llmTaskConfig/llmRouter and the job id is known in the campaign-generation pipeline — three
 * different layers, with ~68 registered tasks and dozens of call sites between them. Threading a
 * parameter through all of that would touch every provider, agent and engine for a
 * cross-cutting concern that none of them care about. A context keeps the accounting entirely out
 * of the business signatures.
 *
 * Contexts NEST and MERGE: the pipeline sets `{ jobId }` once for a whole run, llmRouter sets
 * `{ task }` per call inside it, and a call sees both. An unattributed call (a script, a route
 * outside any job) simply records with no jobId, which is why every field is optional.
 */
export interface LlmUsageContext {
  /** CampaignGenerationJob id, so a run's total token cost can be attributed to it. */
  jobId?: string;
  /** Registered task name from llmTaskConfig (e.g. "strategy-agent", "crawl-fact-extraction"). */
  task?: string;
}

const storage = new AsyncLocalStorage<LlmUsageContext>();

/** Run `fn` with `patch` merged over any surrounding context. */
export function withLlmUsageContext<T>(patch: LlmUsageContext, fn: () => T): T {
  const merged = { ...storage.getStore(), ...patch };
  return storage.run(merged, fn);
}

/** Current attribution, or an empty object outside any context. Never throws. */
export function currentLlmUsageContext(): LlmUsageContext {
  return storage.getStore() ?? {};
}
