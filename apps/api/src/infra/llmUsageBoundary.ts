import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentMonthKey, persistLlmUsage, readMonthTotal, type LlmUsageRecord } from "./llmUsageStore.js";

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

// currentMonthKey now comes from llmUsageStore, so the file fallback and the shared Redis counter
// can never disagree about which month a total belongs to.

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

/**
 * Best-known month total, kept in memory so the guard below can stay SYNCHRONOUS.
 *
 * Redis is the authoritative, cross-container store (llmUsageStore) but it is async, while
 * assertGlobalLlmUsageAvailable() is called synchronously immediately before every dispatch. Rather
 * than make every LLM call await a network round-trip, we hold the last-known total and advance it
 * locally on each record. Consequence, stated plainly: this container can lag a SIBLING
 * container's very recent spend by up to REFRESH_INTERVAL_MS. For a runaway backstop with a
 * deliberately generous cap that is an acceptable trade; it is still vastly better than the
 * previous per-container JSON file, which reset to zero on every deploy.
 */
let cachedTotal: number | null = null;
let cachedMonth = currentMonthKey();
let lastRefreshAt = 0;
const REFRESH_INTERVAL_MS = 30_000;

function refreshFromStoreInBackground(): void {
  if (IS_TEST_RUN) return;
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_INTERVAL_MS) return;
  lastRefreshAt = now;
  void readMonthTotal()
    .then((total) => {
      if (total === null) return;
      const month = currentMonthKey();
      if (month !== cachedMonth) {
        // Month rolled over: Redis keys are month-scoped, so start from its fresh counter.
        cachedMonth = month;
        cachedTotal = total;
        return;
      }
      // Never move backwards: our own un-flushed local increments may lead Redis briefly.
      cachedTotal = Math.max(cachedTotal ?? 0, total);
    })
    .catch(() => {});
}

/** Month-to-date total this process currently believes. Falls back to the legacy file once. */
function currentTotal(): number {
  refreshFromStoreInBackground();
  if (cachedTotal === null) {
    // Cold start: seed from the on-disk ledger so a Redis outage still enforces something.
    cachedTotal = readLedger().totalTokens;
  }
  return cachedTotal;
}

export function isGlobalLlmUsageExceeded(): boolean {
  return currentTotal() >= MONTHLY_TOKEN_BUDGET;
}

/** Throws LlmUsageBoundaryExceededError once the month's combined usage hits the cap.
 * Callers (llmRouter.ts) must check this BEFORE attempting any provider — see the
 * "no fallback" rationale in this file's top comment. */
export function assertGlobalLlmUsageAvailable(): void {
  if (isGlobalLlmUsageExceeded()) throw new LlmUsageBoundaryExceededError();
}

/**
 * Record one call's usage. `detail` carries the task/job attribution and the input/output split so
 * the shared store can build a per-task and per-job breakdown; without it the call still counts
 * toward the cap, just as "unattributed".
 */
export function recordGlobalLlmUsage(totalTokens: number, detail?: Omit<LlmUsageRecord, "totalTokens">): void {
  if (!(totalTokens > 0)) return;

  // Advance the local view immediately so the very next synchronous guard check sees this spend
  // even though the Redis write below has not settled yet.
  cachedTotal = currentTotal() + totalTokens;

  if (IS_TEST_RUN) return;

  // Fire-and-forget: accounting must never block or fail an already-completed LLM call.
  void persistLlmUsage({ totalTokens, inputTokens: detail?.inputTokens ?? 0, outputTokens: detail?.outputTokens ?? 0, task: detail?.task, jobId: detail?.jobId, model: detail?.model })
    .then((authoritative) => {
      if (authoritative !== null) cachedTotal = Math.max(cachedTotal ?? 0, authoritative);
    })
    .catch(() => {});

  // Keep the legacy file as a local fallback for the cold-start seed above, so a Redis outage
  // does not leave a freshly-restarted container believing usage is zero.
  const ledger = readLedger();
  ledger.totalTokens += totalTokens;
  writeLedger(ledger);
}

export function getGlobalLlmMonthUsage(): number {
  return currentTotal();
}

/** Authoritative cross-container total straight from the shared store (null if unreachable). */
export async function getGlobalLlmMonthUsageAuthoritative(): Promise<number | null> {
  return readMonthTotal();
}

export function getGlobalLlmMonthlyBudget(): number {
  return MONTHLY_TOKEN_BUDGET;
}
