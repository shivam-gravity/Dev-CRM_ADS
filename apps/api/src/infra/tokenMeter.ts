/**
 * Lightweight, opt-in per-call token accounting. Unlike llmUsageBoundary.ts (an always-on
 * hard monthly ceiling), this captures prompt/completion token counts for
 * the LLM backend (Gemini, incl. its embeddings) so a run can be profiled end-to-end.
 *
 * Zero-cost when disabled: every recordTokens() call is a no-op unless TOKEN_METER_ENABLED
 * is "true", so leaving the instrumentation in the four clients has no effect on normal runs.
 * Kept in-memory (no file, no DB) — meant to be read via snapshotTokens() at the end of a
 * profiling script running in the same process.
 */
export interface TokenCall {
  provider: string;
  model: string;
  kind: "structured" | "text" | "search" | "embedding" | "image";
  inputTokens: number;
  outputTokens: number;
}

const ENABLED = process.env.TOKEN_METER_ENABLED === "true";
let calls: TokenCall[] = [];

export function recordTokens(call: TokenCall): void {
  if (!ENABLED) return;
  calls.push(call);
}

export function resetTokens(): void {
  calls = [];
}

export function snapshotTokens(): TokenCall[] {
  return [...calls];
}

export function isTokenMeterEnabled(): boolean {
  return ENABLED;
}
