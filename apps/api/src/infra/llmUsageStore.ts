import { Redis, type RedisOptions } from "ioredis";
import { logger } from "../modules/logger/logger.js";

/**
 * Durable, CROSS-CONTAINER accounting for LLM token usage.
 *
 * ── Why this replaced a JSON file ────────────────────────────────────────────────────────────
 * llmUsageBoundary's ledger lived at `<dist>/../../data/llm-usage.json`, INSIDE the container
 * image, and no volume covered it. Two consequences, both verified in production:
 *   1. Every `docker compose up -d` reset the month's total to 0, so the 5M "hard stop" against
 *      runaway usage silently reset on each deploy — it read 0 immediately after a full campaign
 *      generation had just run.
 *   2. `api` and all 10 workers are separate containers, each with its OWN file, so the "global"
 *      monthly cap was really 11 independent caps — roughly 11x looser than intended, and the
 *      heavy LLM consumers are the workers, not `api`.
 * Redis is already shared by all 11 containers (queues, locks, streams) and INCRBY is atomic, so
 * it is the natural home for a counter that must be global and survive deploys.
 *
 * ── Availability posture ─────────────────────────────────────────────────────────────────────
 * Accounting must never fail a caller's already-completed LLM call, and must never block one.
 * Writes are therefore fire-and-forget, and every read/write swallows Redis errors. The tradeoff
 * is documented on the boundary itself: enforcement reads a locally-cached total, so it can lag a
 * sibling container's very recent spend by one refresh interval. For a runaway-usage backstop that
 * is an acceptable trade against making every LLM call await a network round-trip.
 */

/** UTC month key, so the window matches the calendar month everywhere regardless of host TZ. */
export function currentMonthKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * A DEDICATED Redis client for metering, deliberately not the shared `redisClient`.
 *
 * Accounting must never be able to wedge a process. The shared client is configured for queues and
 * locks — `maxRetriesPerRequest: null` and the default reconnect strategy — so a single metering
 * command issued where Redis is unreachable retries and reconnects forever, and its timers keep the
 * event loop alive. That is exactly what happened: after wiring metering in, a unit-test process
 * passed every assertion and then hung until it was killed (exit 143), because one usage read had
 * dialled a Redis that wasn't there.
 *
 * So this client fails FAST and gives up: no offline queue, one attempt, and `retryStrategy`
 * returning null so a dead Redis produces an immediate rejection and leaves no reconnect timer
 * behind. Losing a usage sample is an acceptable price; hanging a worker is not.
 */
const METERING_DISABLED = process.env.LLM_USAGE_METERING_DISABLED === "true";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

function meteringRedisOptions(): RedisOptions {
  const parsed = new URL(REDIS_URL);
  const dbFromPath = parsed.pathname.replace(/^\//, "");
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    password: parsed.password || undefined,
    ...(dbFromPath && Number.isFinite(Number(dbFromPath)) ? { db: Number(dbFromPath) } : {}),
    lazyConnect: true,
    // Offline queueing must stay ON. With lazyConnect the FIRST command is what triggers the
    // connect, so `enableOfflineQueue: false` rejects that very command before the socket is ready —
    // which made every read report "Redis unreachable" against a perfectly healthy Redis.
    // Queueing is bounded in practice because retryStrategy below refuses to reconnect.
    enableOfflineQueue: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    // Never reconnect: a returned null tells ioredis to stop, so no timer outlives a failure.
    retryStrategy: () => null,
  };
}

let client: Redis | null = null;
/** When set, metering is paused until this timestamp — see the cooldown rationale below. */
let unusableUntil = 0;
// Short, because a failure now BUFFERS rather than drops — the cooldown only avoids a connect
// attempt per call in a tight loop, it no longer decides whether data survives.
const UNUSABLE_COOLDOWN_MS = 5_000;

function meteringClient(): Redis | null {
  if (METERING_DISABLED) return null;
  if (unusableUntil > Date.now()) return null;
  if (!client) {
    client = new Redis(meteringRedisOptions());
    // A listener is mandatory: without one ioredis emits 'error' as an unhandled event.
    // A failure disables metering only for a COOLDOWN rather than for the life of the process —
    // this is now the system of record for the monthly cap, so one transient blip must not leave a
    // long-running worker silently unmetered until it restarts.
    client.on("error", () => {
      unusableUntil = Date.now() + UNUSABLE_COOLDOWN_MS;
      const dead = client;
      client = null;
      // retryStrategy returns null so the client is already giving up; disconnect to be certain no
      // handle survives and keeps the process alive.
      try {
        dead?.disconnect();
      } catch {
        /* already gone */
      }
    });
  }
  return client;
}

/** Release the metering connection (scripts should call this so they can exit). */
export async function closeLlmUsageStore(): Promise<void> {
  // Last chance to write anything buffered — otherwise a clean shutdown silently discards it.
  if (client && pending.length > 0) {
    await flushPending(client).catch(() => {});
  }
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
  client = null;
}

const monthTotalKey = (month: string) => `llm:usage:${month}:total`;
const monthTaskKey = (month: string) => `llm:usage:${month}:by-task`;
const jobKey = (jobId: string) => `llm:usage:job:${jobId}`;

/** Month counters are kept well past the month itself so a breakdown stays inspectable. */
const MONTH_TTL_SECONDS = 100 * 24 * 60 * 60;
/** Per-job breakdowns are a debugging/costing aid, not a system of record. */
const JOB_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface LlmUsageRecord {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Registered task name (llmTaskConfig), or "unattributed". */
  task?: string;
  /** CampaignGenerationJob id when the call happened inside a generation run. */
  jobId?: string;
  model?: string;
}

/**
 * Records that could not be written yet, held until Redis is usable again.
 *
 * The first version simply DROPPED anything recorded during the error cooldown, and that lost real
 * data immediately: four vector-image calls fired concurrently and only ONE was recorded, so the
 * per-task call counts under-reported while the token shape looked plausible. Silent partial
 * accounting is worse than none — it invites confident conclusions from wrong numbers.
 *
 * Bounded, because this exists to survive a blip, not to be a durable queue: past the cap the
 * OLDEST entries are discarded and counted, so the loss is visible rather than silent.
 */
interface PendingUsage {
  /** Stamped when recorded, not when flushed, so a flush after a UTC month boundary still lands in the right month. */
  month: string;
  record: LlmUsageRecord;
}
const pending: PendingUsage[] = [];
const PENDING_CAP = 500;
let droppedForOverflow = 0;

function enqueuePending(entry: PendingUsage): void {
  pending.push(entry);
  while (pending.length > PENDING_CAP) {
    pending.shift();
    droppedForOverflow += 1;
    if (droppedForOverflow === 1 || droppedForOverflow % 100 === 0) {
      logger.warn(`llmUsageStore: usage buffer full — discarded ${droppedForOverflow} record(s) while Redis was unavailable`);
    }
  }
}

/** Write one buffered entry's counters into an existing pipeline. */
function queueCommands(redis: Redis, entry: PendingUsage): ReturnType<Redis["pipeline"]> {
  const { month, record } = entry;
  const task = record.task ?? "unattributed";
  const pipeline = redis.pipeline();
  pipeline.incrby(monthTotalKey(month), record.totalTokens);
  pipeline.expire(monthTotalKey(month), MONTH_TTL_SECONDS);
  pipeline.hincrby(monthTaskKey(month), task, record.totalTokens);
  pipeline.hincrby(monthTaskKey(month), `${task}::calls`, 1);
  pipeline.expire(monthTaskKey(month), MONTH_TTL_SECONDS);
  if (record.jobId) {
    pipeline.hincrby(jobKey(record.jobId), "total", record.totalTokens);
    pipeline.hincrby(jobKey(record.jobId), "input", record.inputTokens);
    pipeline.hincrby(jobKey(record.jobId), "output", record.outputTokens);
    pipeline.hincrby(jobKey(record.jobId), task, record.totalTokens);
    pipeline.hincrby(jobKey(record.jobId), `${task}::calls`, 1);
    pipeline.expire(jobKey(record.jobId), JOB_TTL_SECONDS);
  }
  return pipeline;
}

/** Drain whatever is buffered. Anything that fails goes back to the front of the buffer. */
async function flushPending(redis: Redis): Promise<void> {
  while (pending.length > 0) {
    const entry = pending.shift()!;
    try {
      await queueCommands(redis, entry).exec();
    } catch (err) {
      pending.unshift(entry);
      logger.warn(`llmUsageStore: flush failed with ${pending.length} record(s) still buffered`, err);
      return;
    }
  }
}

/**
 * Persist one call's usage. Returns the month's new running total when Redis answered, else null
 * (the caller keeps its own local estimate — see llmUsageBoundary).
 *
 * A failure buffers the record instead of discarding it, and every successful call first drains
 * whatever is buffered — so a transient outage delays accounting rather than losing it.
 */
export async function persistLlmUsage(record: LlmUsageRecord): Promise<number | null> {
  if (!(record.totalTokens > 0)) return null;
  const month = currentMonthKey();
  const redis = meteringClient();
  if (!redis) {
    enqueuePending({ month, record });
    return null;
  }
  const entry: PendingUsage = { month, record };
  try {
    // Drain anything a previous failure buffered before adding this call, so ordering is preserved.
    await flushPending(redis);
    const results = await queueCommands(redis, entry).exec();
    const first = results?.[0];
    const newTotal = first && !first[0] ? Number(first[1]) : NaN;
    return Number.isFinite(newTotal) ? newTotal : null;
  } catch (err) {
    // Buffer, never discard: dropping here is what made four concurrent image calls record as one.
    enqueuePending(entry);
    logger.warn("llmUsageStore: buffered LLM usage after a write failure (accounting only — the call itself succeeded)", err);
    return null;
  }
}

/** How many records are waiting to be written, for diagnostics/reporting. */
export function pendingLlmUsageCount(): number {
  return pending.length;
}

/** Month-to-date total across every container, or null when Redis is unreachable. */
export async function readMonthTotal(month = currentMonthKey()): Promise<number | null> {
  try {
    const redis = meteringClient();
    if (!redis) return null;
    const raw = await redis.get(monthTotalKey(month));
    const value = Number(raw ?? 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return null;
  }
}

export interface TaskUsage {
  task: string;
  tokens: number;
  calls: number;
}

/** Per-task breakdown for a month, biggest consumer first. */
export async function readMonthByTask(month = currentMonthKey()): Promise<TaskUsage[]> {
  try {
    const redis = meteringClient();
    if (!redis) return [];
    const hash = await redis.hgetall(monthTaskKey(month));
    return toTaskUsage(hash);
  } catch {
    return [];
  }
}

/** Per-task breakdown plus totals for one generation job. */
export async function readJobUsage(jobId: string): Promise<{ total: number; input: number; output: number; byTask: TaskUsage[] } | null> {
  try {
    const redis = meteringClient();
    if (!redis) return null;
    const hash = await redis.hgetall(jobKey(jobId));
    if (!hash || Object.keys(hash).length === 0) return null;
    const reserved = new Set(["total", "input", "output"]);
    const taskHash: Record<string, string> = {};
    for (const [k, v] of Object.entries(hash)) if (!reserved.has(k)) taskHash[k] = v;
    return {
      total: Number(hash.total ?? 0),
      input: Number(hash.input ?? 0),
      output: Number(hash.output ?? 0),
      byTask: toTaskUsage(taskHash),
    };
  } catch {
    return null;
  }
}

/** Splits the flat `task` / `task::calls` hash into rows, sorted by tokens descending. */
function toTaskUsage(hash: Record<string, string> | null): TaskUsage[] {
  if (!hash) return [];
  const rows = new Map<string, TaskUsage>();
  for (const [field, value] of Object.entries(hash)) {
    const isCalls = field.endsWith("::calls");
    const task = isCalls ? field.slice(0, -"::calls".length) : field;
    const row = rows.get(task) ?? { task, tokens: 0, calls: 0 };
    if (isCalls) row.calls = Number(value) || 0;
    else row.tokens = Number(value) || 0;
    rows.set(task, row);
  }
  return [...rows.values()].sort((a, b) => b.tokens - a.tokens);
}
