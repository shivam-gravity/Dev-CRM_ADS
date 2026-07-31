import { test } from "node:test";
import assert from "node:assert";
import { currentLlmUsageContext, withLlmUsageContext } from "../infra/llmUsageContext.js";

test("a nested context with no task INHERITS the surrounding one instead of clearing it", () => {
  // This is the bug that produced the "unattributed" bucket. llmRouter wraps every dispatch in
  // withLlmUsageContext({ task: assignment.task }), and an assignment built without a task passes
  // `undefined` — which an object spread writes over the inherited value. Every call through
  // llmClient's runStructured/runText therefore erased its own attribution on the way down.
  const seen = withLlmUsageContext({ jobId: "job-1", task: "creative-intelligence" }, () =>
    withLlmUsageContext({ task: undefined }, () => currentLlmUsageContext())
  );

  assert.strictEqual(seen.task, "creative-intelligence", "an absent task must not erase the outer one");
  assert.strictEqual(seen.jobId, "job-1", "and the job attribution must survive too");
});

test("a nested context with a real task still overrides", () => {
  const seen = withLlmUsageContext({ jobId: "job-1", task: "outer" }, () =>
    withLlmUsageContext({ task: "inner" }, () => currentLlmUsageContext())
  );

  assert.strictEqual(seen.task, "inner", "an explicit task is still the more specific attribution");
  assert.strictEqual(seen.jobId, "job-1");
});

test("attribution does not leak out of its scope", () => {
  withLlmUsageContext({ jobId: "job-1", task: "inner" }, () => currentLlmUsageContext());
  assert.deepStrictEqual(currentLlmUsageContext(), {}, "outside any context there is no attribution");
});
