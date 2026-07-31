import { test } from "node:test";
import assert from "node:assert";
import type { OrchestratorDeps } from "../research/research-orchestrator/ResearchOrchestrator.js";
import type { ResearchJobRecord } from "../research/research-orchestrator/researchJobService.js";
import type { ResearchProvider } from "../research/interfaces/ResearchProvider.js";
import type { ProviderResult, ResearchJobStatus, ResearchProviderInput } from "../research/types/index.js";

/**
 * PROVIDER_TIMEOUT_MS is read from the environment at module load, so it must be shrunk BEFORE the
 * orchestrator is imported — hence the dynamic import below rather than a static one. 150s is the
 * real default; a test can't wait that out, and the behaviour under test is "how many attempts",
 * not "how long".
 */
process.env.RESEARCH_PROVIDER_TIMEOUT_MS = "50";
// Same reason: with no crawl4ai/scraper reachable from a test run, the up-front site prefetch
// would otherwise sit out its full 120s real-world budget before every case here.
process.env.WEBSITE_PREFETCH_TIMEOUT_MS = "50";
const { runResearchOrchestrator, MAX_PROVIDER_ATTEMPTS } = await import("../research/research-orchestrator/ResearchOrchestrator.js");

function fakeJob(): ResearchJobRecord {
  const now = new Date().toISOString();
  return { id: "job-1", workspaceId: "ws-1", businessId: "biz-1", url: "https://example.com", status: "pending", context: null, createdAt: now, updatedAt: now };
}

function deps(job: ResearchJobRecord, executions: ProviderResult<unknown>[]): OrchestratorDeps {
  const statuses: ResearchJobStatus[] = [];
  return {
    async loadJob() { return job; },
    async markStatus(_jobId, status) { statuses.push(status); },
    async recordExecution(_jobId, result) { executions.push(result); },
    async persistSnapshot() {},
    async persistCompleted() {},
  };
}

/** Never settles — the shape that made `search` burn its full budget 19 times out of 19 on prod. */
function hangingProvider(name: string): ResearchProvider<unknown> {
  let calls = 0;
  return {
    name,
    priority: 10,
    execute(_input: ResearchProviderInput): Promise<ProviderResult<unknown>> {
      calls += 1;
      (this as unknown as { calls: number }).calls = calls;
      return new Promise<ProviderResult<unknown>>(() => {});
    },
  } as ResearchProvider<unknown> & { calls: number };
}

/** Throws immediately — a genuinely transient failure, which SHOULD still be retried. */
function throwingProvider(name: string): ResearchProvider<unknown> {
  let calls = 0;
  const provider = {
    name,
    priority: 10,
    async execute(_input: ResearchProviderInput): Promise<ProviderResult<unknown>> {
      calls += 1;
      provider.calls = calls;
      throw new Error("upstream 503");
    },
    calls: 0,
  };
  return provider as unknown as ResearchProvider<unknown>;
}

test("a provider that TIMES OUT is not retried — the retry would spend the same budget for the same result", async () => {
  const job = fakeJob();
  const executions: ProviderResult<unknown>[] = [];
  const provider = hangingProvider("search") as ResearchProvider<unknown> & { calls: number };

  const context = await runResearchOrchestrator("job-1", { providers: [provider], deps: deps(job, executions) });

  // The core assertion: ONE attempt, not MAX_PROVIDER_ATTEMPTS. Two attempts is what put a
  // 150 + 1 + 150 = 301s floor under every research run regardless of the site being researched.
  assert.strictEqual(provider.calls, 1, "a timed-out provider must not be executed a second time");
  assert.strictEqual(executions.length, 1, "exactly one ProviderExecution row for the single attempt");
  assert.strictEqual(executions[0].status, "failed");
  assert.match(String(executions[0].error), /timed out after 50ms/);
  assert.ok(context.metadata.providersFailed.includes("search"), "the failure is still reported honestly");
});

test("a provider that throws a transient error IS still retried", async () => {
  const job = fakeJob();
  const executions: ProviderResult<unknown>[] = [];
  const provider = throwingProvider("market") as unknown as ResearchProvider<unknown> & { calls: number };

  await runResearchOrchestrator("job-1", { providers: [provider], deps: deps(job, executions) });

  // Guards the other side of the change: skipping the retry for timeouts must not have skipped it
  // for the 5xx / dropped-socket failures the retry was actually built for.
  assert.strictEqual(provider.calls, MAX_PROVIDER_ATTEMPTS, "a transient failure keeps its retry");
  assert.strictEqual(executions.length, MAX_PROVIDER_ATTEMPTS);
});
