/**
 * Print LLM token usage: month-to-date total, the per-task breakdown, and optionally one
 * campaign-generation job's cost.
 *
 * Exists because the previous accounting answered no useful question — a single running total in a
 * per-container JSON file that reset on every deploy. Usage is now in Redis (shared by all 11
 * containers, survives deploys), tagged by task and attributed to the generation job that spent it.
 *
 *   node dist/scripts/llmUsageReport.js                 # month to date, by task
 *   node dist/scripts/llmUsageReport.js <jobId>         # one generation run's cost
 *   node dist/scripts/llmUsageReport.js --month 2026-07
 */
import { getGlobalLlmMonthlyBudget } from "../infra/llmUsageBoundary.js";
import { closeLlmUsageStore, currentMonthKey, readJobUsage, readMonthByTask, readMonthTotal } from "../infra/llmUsageStore.js";

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0.0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const monthFlag = args.indexOf("--month");
  const month = monthFlag >= 0 ? args[monthFlag + 1] : currentMonthKey();
  const jobId = args.find((a) => !a.startsWith("--") && a !== month);

  if (jobId) {
    const usage = await readJobUsage(jobId);
    if (!usage) {
      console.log(`No recorded usage for job ${jobId}.`);
      console.log("Either it ran before metering was enabled, or its 30-day retention has expired.");
      return;
    }
    console.log(`\nGeneration job ${jobId}`);
    console.log(`  total tokens : ${n(usage.total)}  (input ${n(usage.input)} / output+thinking ${n(usage.output)})`);
    console.log(`\n  ${"task".padEnd(36)} ${"tokens".padStart(12)} ${"calls".padStart(6)} ${"share".padStart(7)}`);
    for (const row of usage.byTask) {
      console.log(`  ${row.task.padEnd(36)} ${n(row.tokens).padStart(12)} ${String(row.calls).padStart(6)} ${pct(row.tokens, usage.total).padStart(7)}`);
    }
    return;
  }

  const total = await readMonthTotal(month);
  const budget = getGlobalLlmMonthlyBudget();
  console.log(`\nLLM usage for ${month}`);
  if (total === null) {
    console.log("  Redis unreachable — cannot read the shared ledger.");
    return;
  }
  console.log(`  month to date : ${n(total)} tokens / cap ${n(budget)} (${pct(total, budget)})`);

  const byTask = await readMonthByTask(month);
  if (byTask.length === 0) {
    console.log("  No per-task rows yet — nothing has spent tokens since metering was enabled.");
    return;
  }
  console.log(`\n  ${"task".padEnd(36)} ${"tokens".padStart(12)} ${"calls".padStart(6)} ${"avg/call".padStart(9)} ${"share".padStart(7)}`);
  for (const row of byTask) {
    const avg = row.calls > 0 ? Math.round(row.tokens / row.calls) : 0;
    console.log(`  ${row.task.padEnd(36)} ${n(row.tokens).padStart(12)} ${String(row.calls).padStart(6)} ${n(avg).padStart(9)} ${pct(row.tokens, total).padStart(7)}`);
  }
  const calls = byTask.reduce((sum, r) => sum + r.calls, 0);
  console.log(`\n  ${byTask.length} distinct tasks, ${n(calls)} calls total`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeLlmUsageStore();
  });
