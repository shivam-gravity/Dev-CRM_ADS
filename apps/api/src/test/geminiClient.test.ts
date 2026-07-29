import { test } from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";

// geminiClient.ts reads GEMINI_API_KEY / GEMINI_* at module load, so the env must be set BEFORE the
// dynamic import below, and the fetch mock installed via a stable indirection captured before the
// module resolves (same constraint as the other client tests).
// Opt the global usage boundary out of the way for this unit test: it reads a persistent monthly
// token ledger, and a dev machine that has run real research this month can already be at/over the
// 5M default cap — which would make these MOCKED-fetch tests fail on assertGlobalLlmUsageAvailable
// before the mock is even hit. An explicit budget env wins over the default (see llmUsageBoundary.ts),
// and a dedicated temp ledger keeps this test from touching the real one. Both are read at module
// load, so they must be set before the dynamic import below.
process.env.LLM_MONTHLY_TOKEN_BUDGET = String(Number.MAX_SAFE_INTEGER);
process.env.LLM_USAGE_LEDGER_PATH = path.join(os.tmpdir(), "polluxa-gemini-test-usage.json");
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.GEMINI_MODEL = "gemini-flash-latest";
process.env.GEMINI_EMBEDDING_DIMENSIONS = "4"; // tiny vector keeps the normalization assertion readable
process.env.GEMINI_MAX_CONCURRENCY = "3";
process.env.GEMINI_MAX_RETRIES = "2";
process.env.GEMINI_MAX_BACKOFF_MS = "10"; // keep the retry test fast

let currentFetchImpl: typeof fetch = (async () => {
  throw new Error("no fetch impl installed for this test");
}) as typeof fetch;
global.fetch = ((...args: Parameters<typeof fetch>) => currentFetchImpl(...args)) as typeof fetch;

const { runStructured, runText, createEmbedding, isGeminiConfigured } = await import("../infra/geminiClient.js");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// The forced-function-call response shape: `args` is an already-parsed object, NOT a JSON string.
function functionCallResponse(name: string, args: unknown): Response {
  return jsonResponse({
    candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  });
}

const TOOL = { name: "emit_test", description: "test tool", input_schema: { type: "object" as const, properties: { ok: { type: "boolean" } } } };
const BASE_OPTS = { maxTokens: 100, messages: [{ role: "user" as const, content: "hi" }], tool: TOOL };

test("geminiClient.isGeminiConfigured - true when GEMINI_API_KEY is set", () => {
  assert.strictEqual(isGeminiConfigured(), true);
});

test("geminiClient.runStructured - forces the function call, keys via header not URL, returns parsed args", async () => {
  let capturedUrl: string | undefined;
  let capturedBody: any;
  let capturedKeyHeader: string | undefined;
  currentFetchImpl = (async (url, init) => {
    capturedUrl = String(url);
    capturedKeyHeader = ((init as RequestInit).headers as Record<string, string>)["x-goog-api-key"];
    capturedBody = JSON.parse(String((init as RequestInit).body));
    return functionCallResponse("emit_test", { ok: true });
  }) as typeof fetch;

  const result = await runStructured<{ ok: boolean }>(BASE_OPTS);

  assert.ok(capturedUrl?.includes("generativelanguage.googleapis.com"), `expected the Gemini host, got: ${capturedUrl}`);
  assert.ok(capturedUrl?.includes(":generateContent"), "must call the generateContent endpoint");
  assert.strictEqual(capturedKeyHeader, "test-gemini-key", "must send the key as a header");
  // The key must never appear in the URL — URLs get logged by proxies and error handlers.
  assert.ok(!capturedUrl?.includes("test-gemini-key"), "the API key must not be in the URL");
  // ANY-mode + allowedFunctionNames is what forces a schema-shaped answer instead of prose.
  assert.deepStrictEqual(capturedBody.toolConfig.functionCallingConfig, { mode: "ANY", allowedFunctionNames: ["emit_test"] });
  assert.deepStrictEqual(capturedBody.tools[0].functionDeclarations[0].parameters, TOOL.input_schema);
  assert.deepStrictEqual(result, { ok: true });
});

test("geminiClient.runStructured - a response with no functionCall part resolves to null", async () => {
  currentFetchImpl = (async () => jsonResponse({ candidates: [{ content: { parts: [{ text: "no tool here" }] } }], usageMetadata: {} })) as typeof fetch;
  const result = await runStructured(BASE_OPTS);
  assert.strictEqual(result, null);
});

test("geminiClient.runStructured - a safety block (no candidates) resolves to null, not a throw", async () => {
  currentFetchImpl = (async () => jsonResponse({ promptFeedback: { blockReason: "SAFETY" } })) as typeof fetch;
  const result = await runStructured(BASE_OPTS);
  assert.strictEqual(result, null, "a blocked prompt must degrade to null like any other empty result");
});

test("geminiClient.runText - concatenates the model's text parts", async () => {
  currentFetchImpl = (async () =>
    jsonResponse({
      candidates: [{ content: { parts: [{ text: "hello " }, { text: "from gemini" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
    })) as typeof fetch;
  const result = await runText({ maxTokens: 100, messages: [{ role: "user", content: "hi" }] });
  assert.strictEqual(result, "hello from gemini");
});

test("geminiClient.runText - system prompt maps to systemInstruction, and maxTokens to generationConfig", async () => {
  let capturedBody: any;
  currentFetchImpl = (async (_url, init) => {
    capturedBody = JSON.parse(String((init as RequestInit).body));
    return jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: {} });
  }) as typeof fetch;
  await runText({ maxTokens: 50, system: "You are terse.", messages: [{ role: "user", content: "hi" }] });
  assert.deepStrictEqual(capturedBody.systemInstruction, { parts: [{ text: "You are terse." }] });
  assert.strictEqual(capturedBody.generationConfig.maxOutputTokens, 50);
});

test("geminiClient - the assistant role is sent as \"model\" (Gemini rejects \"assistant\")", async () => {
  let capturedBody: any;
  currentFetchImpl = (async (_url, init) => {
    capturedBody = JSON.parse(String((init as RequestInit).body));
    return jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: {} });
  }) as typeof fetch;
  await runText({
    maxTokens: 50,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ],
  });
  assert.deepStrictEqual(
    capturedBody.contents.map((c: { role: string }) => c.role),
    ["user", "model", "user"]
  );
});

test("geminiClient.runStructured - retries a 429 (RESOURCE_EXHAUSTED) then succeeds", async () => {
  let calls = 0;
  currentFetchImpl = (async () => {
    calls += 1;
    if (calls === 1) return new Response("resource exhausted", { status: 429 });
    return functionCallResponse("emit_test", { ok: true });
  }) as typeof fetch;

  const result = await runStructured<{ ok: boolean }>(BASE_OPTS);
  assert.strictEqual(calls, 2, "should retry once after a 429");
  assert.deepStrictEqual(result, { ok: true });
});

test("geminiClient.runStructured - caps concurrent requests (set to 3) so a fan-out burst can't trip the per-minute quota", async () => {
  let active = 0;
  let peakActive = 0;
  currentFetchImpl = (async () => {
    active += 1;
    peakActive = Math.max(peakActive, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    return functionCallResponse("emit_test", { ok: true });
  }) as typeof fetch;

  await Promise.all(Array.from({ length: 8 }, () => runStructured(BASE_OPTS)));
  assert.ok(peakActive <= 3, `expected at most 3 concurrent Gemini requests, saw ${peakActive}`);
});

test("geminiClient.createEmbedding - requests the configured dimensionality and returns a UNIT vector", async () => {
  let capturedBody: any;
  currentFetchImpl = (async (url, init) => {
    assert.ok(String(url).includes(":embedContent"), "must call the embedContent endpoint");
    capturedBody = JSON.parse(String((init as RequestInit).body));
    // Deliberately NOT unit length (magnitude 4): reduced-dimensionality Gemini embeddings come back
    // un-normalized, and ResearchMemoryStore's cosine similarity assumes unit vectors.
    return jsonResponse({ embedding: { values: [2, 2, 2, 2] } });
  }) as typeof fetch;

  const vector = await createEmbedding("some text");

  assert.strictEqual(capturedBody.outputDimensionality, 4);
  assert.ok(vector, "expected an embedding");
  const magnitude = Math.sqrt((vector as number[]).reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(magnitude - 1) < 1e-9, `expected a unit vector, got magnitude ${magnitude}`);
  assert.deepStrictEqual(vector, [0.5, 0.5, 0.5, 0.5]);
});

test("geminiClient.createEmbedding - a zero-magnitude vector resolves to null rather than NaNs", async () => {
  currentFetchImpl = (async () => jsonResponse({ embedding: { values: [0, 0, 0, 0] } })) as typeof fetch;
  const vector = await createEmbedding("some text");
  assert.strictEqual(vector, null, "normalizing a zero vector would divide by zero and poison every later comparison");
});

test.after(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_EMBEDDING_DIMENSIONS;
  delete process.env.GEMINI_MAX_CONCURRENCY;
  delete process.env.GEMINI_MAX_RETRIES;
  delete process.env.GEMINI_MAX_BACKOFF_MS;
});
