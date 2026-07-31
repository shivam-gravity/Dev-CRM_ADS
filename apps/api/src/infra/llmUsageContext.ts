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

/**
 * Run `fn` with `patch` merged over any surrounding context.
 *
 * An UNDEFINED field in `patch` means "I have nothing to add", not "clear what the caller set".
 * A plain object spread doesn't distinguish those — an explicitly-undefined key still overwrites —
 * so `withLlmUsageContext({ task: undefined })` used to erase the surrounding attribution. That is
 * exactly what llmRouter does when an assignment carries no task, which is how the intelligence
 * engines and every other caller of llmClient's runStructured/runText landed in the
 * "unattributed" bucket: 14.8% of a month's tokens with no task and no jobId against them, and
 * therefore invisible to per-job cost accounting.
 */
export function withLlmUsageContext<T>(patch: LlmUsageContext, fn: () => T): T {
  const current = storage.getStore();
  const merged: LlmUsageContext = { ...current };
  if (patch.jobId !== undefined) merged.jobId = patch.jobId;
  if (patch.task !== undefined) merged.task = patch.task;
  return storage.run(merged, fn);
}

/** Current attribution, or an empty object outside any context. Never throws. */
export function currentLlmUsageContext(): LlmUsageContext {
  return storage.getStore() ?? {};
}
