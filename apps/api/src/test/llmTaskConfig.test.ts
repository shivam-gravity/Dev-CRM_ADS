import { test } from "node:test";
import assert from "node:assert";
import { resolveTaskModel } from "../infra/llmTaskConfig.js";

// Mirrors llmTaskConfig.ts's own default resolution rather than hardcoding the model id, so a
// deployment (or CI) that sets GEMINI_MODEL doesn't fail these tests for the wrong reason.
const GEMINI_DEFAULT = { provider: "gemini", model: process.env.GEMINI_MODEL ?? "gemini-flash-latest" };

test("resolveTaskModel - no override anywhere resolves to the Gemini default", () => {
  const assignment = resolveTaskModel("some-unassigned-task");
  assert.deepStrictEqual({ provider: assignment.provider, model: assignment.model }, GEMINI_DEFAULT);
});

test("resolveTaskModel - a valid env override wins over the default", () => {
  process.env.LLM_TASK_TEST_AGENT = "gemini:gemini-pro-latest";
  try {
    const assignment = resolveTaskModel("test-agent");
    assert.deepStrictEqual({ provider: assignment.provider, model: assignment.model }, { provider: "gemini", model: "gemini-pro-latest" });
  } finally {
    delete process.env.LLM_TASK_TEST_AGENT;
  }
});

// The parser splits on the FIRST colon only, so a model id containing colons survives intact.
// Gemini's plain ids don't need this, but tuned-model resource names do (and getting it wrong
// silently truncates the model, which then 404s at call time rather than failing here).
test("resolveTaskModel - env override preserves colons in the model name", () => {
  process.env.LLM_TASK_TEST_AGENT = "gemini:tunedModels/my-tune:v2";
  try {
    const assignment = resolveTaskModel("test-agent");
    assert.deepStrictEqual({ provider: assignment.provider, model: assignment.model }, { provider: "gemini", model: "tunedModels/my-tune:v2" });
  } finally {
    delete process.env.LLM_TASK_TEST_AGENT;
  }
});

test("resolveTaskModel - task name hyphens map to underscores in the env var key, and wins over that task's own static registry entry", () => {
  process.env.LLM_TASK_BUDGET_AGENT = "gemini:gemini-flash-lite-latest";
  try {
    const assignment = resolveTaskModel("budget-agent");
    assert.deepStrictEqual({ provider: assignment.provider, model: assignment.model }, { provider: "gemini", model: "gemini-flash-lite-latest" });
  } finally {
    delete process.env.LLM_TASK_BUDGET_AGENT;
  }
});

test("resolveTaskModel - an unrecognized provider in the env override is ignored, falls through to default", () => {
  process.env.LLM_TASK_TEST_AGENT = "bogus-provider:some-model";
  try {
    const assignment = resolveTaskModel("test-agent");
    assert.deepStrictEqual({ provider: assignment.provider, model: assignment.model }, GEMINI_DEFAULT);
  } finally {
    delete process.env.LLM_TASK_TEST_AGENT;
  }
});

// "bedrock" is in this list deliberately: it WAS the only valid provider, so a stale
// LLM_TASK_*="bedrock:..." left in a deployment's env must fall through to the Gemini default
// rather than producing an assignment no client can serve.
test("resolveTaskModel - a now-removed provider (bedrock/mistral/openrouter/ollama/google) in the env override is ignored", () => {
  for (const removed of [
    "bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "mistral:mistral-small-latest",
    "openrouter:foo",
    "ollama:llama3.1:8b",
    "google:gemini-2.0-flash",
  ]) {
    process.env.LLM_TASK_TEST_AGENT = removed;
    try {
      const a = resolveTaskModel("test-agent");
      assert.deepStrictEqual({ provider: a.provider, model: a.model }, GEMINI_DEFAULT, `${removed} must not resolve`);
    } finally {
      delete process.env.LLM_TASK_TEST_AGENT;
    }
  }
});

test("resolveTaskModel - a malformed env override (no colon at all) is ignored, falls through to default", () => {
  process.env.LLM_TASK_TEST_AGENT = "gemini-no-separator";
  try {
    const assignment = resolveTaskModel("test-agent");
    assert.deepStrictEqual({ provider: assignment.provider, model: assignment.model }, GEMINI_DEFAULT);
  } finally {
    delete process.env.LLM_TASK_TEST_AGENT;
  }
});

test("resolveTaskModel - an env override with an empty model name is ignored, falls through to default", () => {
  process.env.LLM_TASK_TEST_AGENT = "gemini:";
  try {
    const assignment = resolveTaskModel("test-agent");
    assert.deepStrictEqual({ provider: assignment.provider, model: assignment.model }, GEMINI_DEFAULT);
  } finally {
    delete process.env.LLM_TASK_TEST_AGENT;
  }
});

test("resolveTaskModel - stamps the task name onto the assignment (this is what makes token usage attributable per task)", () => {
  // llmRouter reads assignment.task and records usage under it, so ~68 tasks become individually
  // costed with no change at any call site. A missing tag would silently collapse everything into
  // "unattributed", which is exactly the blind spot this replaced.
  assert.strictEqual(resolveTaskModel("crawl-fact-extraction").task, "crawl-fact-extraction");
  assert.strictEqual(resolveTaskModel("some-unassigned-task").task, "some-unassigned-task");
});

test("resolveTaskModel - never mutates the shared registry entry when stamping the task", () => {
  // The registry maps many tasks to ONE shared GEMINI object; stamping it in place would make every
  // task inherit whichever name was resolved last.
  const first = resolveTaskModel("campaign-agent");
  const second = resolveTaskModel("audience-agent");
  assert.strictEqual(first.task, "campaign-agent");
  assert.strictEqual(second.task, "audience-agent");
});
