import { test } from "node:test";
import assert from "node:assert";
// Loaded before geminiClient is imported below, because that module reads GEMINI_* at module load.
import "dotenv/config";

/**
 * Live guard for the thinking-token trap, which the MOCKED tests structurally cannot catch.
 *
 * geminiClient.test.ts asserts the request SHAPE (that maxOutputTokens carries the thinking
 * allowance) — but a mock can only ever confirm we send what we intended to send. It cannot tell us
 * whether the model's actual thinking consumption fits inside that allowance, and that is the thing
 * that broke: thought tokens are drawn from the same maxOutputTokens budget as the answer, so a
 * tight maxTokens produced finishReason=MAX_TOKENS with NO parts — an empty SUCCESS, not an error.
 * Every caller here reads empty as "this leg produced nothing", so it degraded output silently.
 *
 * The earlier live tests (crawlPersistence.live, decisionEngine.live) all passed while that bug was
 * present, because their budgets happened to be generous. Only a deliberately TIGHT budget exposes
 * it. That is why this file exists, and why the budgets below are small on purpose — do not raise
 * them to make a failure go away, that would delete the coverage.
 *
 * Skipped without a key so CI stays green; it is a guard for real environments.
 */
const SKIP = !process.env.GEMINI_API_KEY;

const { runText, runStructured, createEmbedding, embeddingDimensions } = await import("../infra/geminiClient.js");

// Smallest budget any call site in the codebase uses (see the maxTokens: 32 caller). If thinking
// ever starts eating the allowance again, this is the first thing that fails.
const TIGHT_MAX_TOKENS = 32;

test("geminiClient (live) - a TIGHT maxTokens still returns visible text, not an empty success", { skip: SKIP }, async () => {
  const text = await runText({
    maxTokens: TIGHT_MAX_TOKENS,
    messages: [{ role: "user", content: "Reply with exactly: GEMINI_OK" }],
  });
  assert.ok(
    text && text.trim().length > 0,
    `runText at maxTokens=${TIGHT_MAX_TOKENS} returned ${JSON.stringify(text)}. ` +
      "Thinking tokens are almost certainly consuming the output budget again — raise " +
      "GEMINI_THINKING_BUDGET rather than this test's maxTokens."
  );
});

test("geminiClient (live) - a TIGHT maxTokens still yields a schema-shaped structured result", { skip: SKIP }, async () => {
  const result = await runStructured<{ ok: boolean }>({
    maxTokens: TIGHT_MAX_TOKENS,
    messages: [{ role: "user", content: "Return ok=true" }],
    tool: {
      name: "emit_ok",
      description: "emit the boolean",
      input_schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    },
  });
  assert.ok(result, `runStructured at maxTokens=${TIGHT_MAX_TOKENS} returned null — see the runText guard above`);
  assert.strictEqual(result.ok, true);
});

// Embeddings have no thinking budget to compete with, but they DO have a contract
// ResearchMemoryStore depends on: a fixed width, and unit length so cosine similarity can be a
// plain dot product. A provider-side change to either would silently corrupt every similarity score.
test("geminiClient (live) - embeddings come back at the configured width and unit length", { skip: SKIP }, async () => {
  const vector = await createEmbedding("live embedding contract check");
  assert.ok(vector, "createEmbedding returned null");
  assert.strictEqual(vector.length, embeddingDimensions(), "width must match GEMINI_EMBEDDING_DIMENSIONS");
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(magnitude - 1) < 1e-6, `expected a unit vector, got magnitude ${magnitude}`);
});
