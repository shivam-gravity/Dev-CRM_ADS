import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Detect a test run so the suite never consumes — or trips — the real production ledger. Every test
// file shares one process (tsx --test) and LEDGER_PATH/MONTHLY_TOKEN_BUDGET are captured once at
// module load, so a single accidental accumulation to the cap would otherwise break every
// subsequent LLM-backed test until the ledger is hand-reset (exactly what happened once). In a test
// run the ledger is redirected to a throwaway temp file and the cap is effectively disabled. An
// explicit LLM_USAGE_LEDGER_PATH / LLM_MONTHLY_TOKEN_BUDGET still wins, so a test can opt back in to
// exercising the boundary directly.
const IS_TEST_RUN =
  process.env.NODE_ENV === "test" ||
  process.env.npm_lifecycle_event === "test" ||
  process.argv.includes("--test") ||
  process.execArgv.includes("--test");

/**
 * A single hard ceiling on LLM token usage against the one backend (Gemini) —
 * distinct from tokenMeter.ts (which is opt-in, in-memory-only, single-run profiling). This is
 * always-on and persistent: a real backstop against runaway usage (a bug causing a retry storm,
 * an unexpectedly large batch).
 *
 * Enforcement is deliberately a hard stop: llmRouter.ts checks this BEFORE dispatching the
 * Gemini call, so once tripped, nothing attempts a call for the rest of the UTC month.
 */

const DEFAULT_LEDGER_PATH = IS_TEST_RUN
  ? path.join(os.tmpdir(), "polluxa-test-llm-usage.json")
  : path.resolve(__dirname, "../../data", "llm-usage.json");
const LEDGER_PATH = process.env.LLM_USAGE_LEDGER_PATH ?? DEFAULT_LEDGER_PATH;

// Deliberately generous — this exists to catch runaway usage (a retry storm, an unexpectedly
// large batch), not to be the primary lever for day-to-day cost control.
const DEFAULT_MONTHLY_TOKEN_BUDGET = IS_TEST_RUN ? Number.MAX_SAFE_INTEGER : 5_000_000;
const MONTHLY_TOKEN_BUDGET = Number(process.env.LLM_MONTHLY_TOKEN_BUDGET ?? DEFAULT_MONTHLY_TOKEN_BUDGET);

interface Ledger {
  month: string; // "YYYY-MM", UTC
  totalTokens: number;
}

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function readLedger(): Ledger {
  try {
    const raw = fs.readFileSync(LEDGER_PATH, "utf8");
    const parsed = JSON.parse(raw) as Ledger;
    if (parsed.month === currentMonthKey() && typeof parsed.totalTokens === "number") return parsed;
  } catch {
    // No ledger yet, unreadable, or corrupt — start the month fresh rather than block calls.
  }
  return { month: currentMonthKey(), totalTokens: 0 };
}

function writeLedger(ledger: Ledger): void {
  try {
    fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger), "utf8");
  } catch (err) {
    // A write failure here means this call's tokens go untracked — never a reason to fail
    // the caller's actual, already-completed LLM call.
    // eslint-disable-next-line no-console
    console.warn("llmUsageBoundary: failed to persist usage ledger", err);
  }
}

export class LlmUsageBoundaryExceededError extends Error {
  constructor() {
    super(`Global LLM token budget exceeded for this month (cap: ${MONTHLY_TOKEN_BUDGET.toLocaleString()} tokens) — see infra/llmUsageBoundary.ts`);
    this.name = "LlmUsageBoundaryExceededError";
  }
}

export function isGlobalLlmUsageExceeded(): boolean {
  return readLedger().totalTokens >= MONTHLY_TOKEN_BUDGET;
}

/** Throws LlmUsageBoundaryExceededError once the month's combined usage hits the cap.
 * Callers (llmRouter.ts) must check this BEFORE attempting any provider — see the
 * "no fallback" rationale in this file's top comment. */
export function assertGlobalLlmUsageAvailable(): void {
  if (isGlobalLlmUsageExceeded()) throw new LlmUsageBoundaryExceededError();
}

export function recordGlobalLlmUsage(totalTokens: number): void {
  if (!(totalTokens > 0)) return;
  const ledger = readLedger();
  ledger.totalTokens += totalTokens;
  writeLedger(ledger);
}

export function getGlobalLlmMonthUsage(): number {
  return readLedger().totalTokens;
}

export function getGlobalLlmMonthlyBudget(): number {
  return MONTHLY_TOKEN_BUDGET;
}
