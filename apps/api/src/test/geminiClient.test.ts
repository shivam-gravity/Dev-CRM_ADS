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
// Keep metering entirely local: a usage read would otherwise dial Redis, which is absent in a
// unit test, and the resulting connection attempt kept the process alive after every
// assertion had already passed (the run exited 143 on a timeout rather than finishing).
process.env.LLM_USAGE_METERING_DISABLED = "true";
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.GEMINI_MODEL = "gemini-flash-latest";
process.env.GEMINI_EMBEDDING_DIMENSIONS = "4"; // tiny vector keeps the normalization assertion readable
process.env.GEMINI_THINKING_BUDGET = "256"; // pinned so the headroom assertion below is deterministic
process.env.GEMINI_MAX_CONCURRENCY = "3";
process.env.GEMINI_MAX_RETRIES = "2";
process.env.GEMINI_MAX_BACKOFF_MS = "10"; // keep the retry test fast

let currentFetchImpl: typeof fetch = (async () => {
  throw new Error("no fetch impl installed for this test");
}) as typeof fetch;
global.fetch = ((...args: Parameters<typeof fetch>) => currentFetchImpl(...args)) as typeof fetch;

const { runStructured, runText, createEmbedding, isGeminiConfigured, sanitizeGeminiSchema } = await import("../infra/geminiClient.js");

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
  // 50 requested output + 256 thinking allowance — see the dedicated headroom test below for why.
  assert.strictEqual(capturedBody.generationConfig.maxOutputTokens, 306);
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

// Regression guard for the thinking-token trap. Thought tokens are drawn from maxOutputTokens, so
// sending the caller's maxTokens verbatim lets a thinking model spend the whole budget reasoning and
// return NO parts — an empty success that every caller reads as "produced nothing". Verified live:
// maxOutputTokens=32 gave finishReason MAX_TOKENS with 29 thought tokens and no output at all.
test("geminiClient - the caller's maxTokens is the OUTPUT budget; thinking gets its own allowance on top", async () => {
  let capturedBody: any;
  currentFetchImpl = (async (_url, init) => {
    capturedBody = JSON.parse(String((init as RequestInit).body));
    return functionCallResponse("emit_test", { ok: true });
  }) as typeof fetch;

  await runStructured({ ...BASE_OPTS, maxTokens: 100 });

  assert.strictEqual(capturedBody.generationConfig.maxOutputTokens, 356, "must be maxTokens (100) + thinking allowance (256)");
  assert.deepStrictEqual(capturedBody.generationConfig.thinkingConfig, { thinkingBudget: 256 }, "thinking must be explicitly capped");
});

test("geminiClient - a MAX_TOKENS response with no parts resolves to null instead of throwing", async () => {
  currentFetchImpl = (async () =>
    jsonResponse({
      candidates: [{ finishReason: "MAX_TOKENS" }], // no content/parts at all — what a starved thinking call returns
      usageMetadata: { promptTokenCount: 9, thoughtsTokenCount: 29 },
    })) as typeof fetch;

  assert.strictEqual(await runStructured(BASE_OPTS), null);
  assert.strictEqual(await runText({ maxTokens: 32, messages: [{ role: "user", content: "hi" }] }), null);
});

test("geminiClient.fetchWithRetry - a thrown network error is retried, not propagated as a dead call", async () => {
  // fetch() THROWS on connection-level failures instead of returning a status, so these bypassed the
  // status-based retry entirely and killed the call on the first blip. Observed live as three agents
  // lost to `TypeError: fetch failed` seconds apart, each silently degrading to its template fallback.
  let calls = 0;
  currentFetchImpl = (async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("fetch failed");
    return functionCallResponse("emit_test", { ok: true });
  }) as typeof fetch;

  const result = await runStructured<{ ok: boolean }>(BASE_OPTS);
  assert.strictEqual(calls, 3, "must retry through the transient network errors");
  assert.deepStrictEqual(result, { ok: true }, "and still return the eventual success");
});

test("geminiClient.fetchWithRetry - a persistent network error gives up after the retry budget and surfaces the cause", async () => {
  let calls = 0;
  currentFetchImpl = (async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  // geminiClient SURFACES the failure; llmRouter is the layer that degrades it to null (see
  // llmRouter.test.ts "a Gemini failure degrades to null ... never throws"). Assert the boundary
  // here so a retry loop that silently swallowed errors — or spun forever — would fail this test.
  await assert.rejects(() => runStructured(BASE_OPTS), /network/i);
  assert.strictEqual(calls, 3, "must stop at GEMINI_MAX_RETRIES=2 (3 attempts total), not loop forever");
});

// ── Schema translation for Gemini's restricted FunctionDeclaration proto ──
// These two shapes were live in production and each made Gemini reject the WHOLE call with 400
// INVALID_ARGUMENT. The failure was invisible: llmRouter logged a warning, returned null, and the
// agent silently emitted its hardcoded template copy with usedFallback=true and NO error recorded.

test("geminiClient.sanitizeGeminiSchema - drops additionalProperties (Gemini's proto has no such field)", () => {
  // Verbatim shape from StrategyAgent's budgetSplit, which 400'd with
  // 'Unknown name "additionalProperties" ... Cannot find field' on every campaign generation.
  const sanitized = sanitizeGeminiSchema({
    type: "object",
    properties: {
      budgetSplit: { type: "object", additionalProperties: { type: "number" }, description: "keep me" },
    },
  }) as any;

  assert.ok(!("additionalProperties" in sanitized.properties.budgetSplit), "additionalProperties must be gone");
  assert.strictEqual(sanitized.properties.budgetSplit.type, "object", "the rest of the node survives");
  assert.strictEqual(sanitized.properties.budgetSplit.description, "keep me", "sibling keys are untouched");
});

test("geminiClient.sanitizeGeminiSchema - collapses a nullable type union to a single type + nullable", () => {
  // Verbatim shape from PricingIntelligenceEngine's startingPriceUsd, which 400'd with
  // 'Unknown name "type" ... Proto field is not repeating, cannot start list'.
  const sanitized = sanitizeGeminiSchema({
    type: "object",
    properties: { startingPriceUsd: { type: ["number", "null"], description: "price" } },
  }) as any;

  assert.strictEqual(sanitized.properties.startingPriceUsd.type, "number", "type must be a single scalar");
  assert.strictEqual(sanitized.properties.startingPriceUsd.nullable, true, "nullability moves to `nullable`");
});

test("geminiClient.sanitizeGeminiSchema - recurses through items/properties and leaves valid schemas identical", () => {
  const nested = sanitizeGeminiSchema({
    type: "object",
    properties: {
      rows: {
        type: "array",
        items: { type: "object", properties: { score: { type: ["number", "null"] } }, additionalProperties: false },
      },
    },
    required: ["rows"],
  }) as any;
  assert.strictEqual(nested.properties.rows.items.properties.score.type, "number", "must fix nested unions");
  assert.strictEqual(nested.properties.rows.items.properties.score.nullable, true);
  assert.ok(!("additionalProperties" in nested.properties.rows.items), "must strip nested additionalProperties");
  assert.deepStrictEqual(nested.required, ["rows"], "supported keywords pass through");

  // A schema that was already legal must be byte-identical — this is what keeps the sanitizer from
  // quietly changing the ~40 other tool schemas in the pipeline.
  const legal = { type: "object", properties: { ok: { type: "boolean" }, tags: { type: "array", items: { type: "string" } } }, required: ["ok"] };
  assert.deepStrictEqual(sanitizeGeminiSchema(legal), legal);
});

test("geminiClient.runStructured - the schema actually sent to Gemini is the sanitized one", async () => {
  // End-to-end guard: the sanitizer has to be wired into the request path, not merely exported.
  let capturedBody: any;
  currentFetchImpl = (async (_url, init) => {
    capturedBody = JSON.parse(String((init as RequestInit).body));
    return functionCallResponse("emit_test", { ok: true });
  }) as typeof fetch;

  await runStructured({
    ...BASE_OPTS,
    tool: {
      name: "emit_test",
      description: "test tool",
      input_schema: { type: "object" as const, properties: { split: { type: "object", additionalProperties: { type: "number" } } } },
    },
  });

  const sent = capturedBody.tools[0].functionDeclarations[0].parameters;
  assert.ok(!JSON.stringify(sent).includes("additionalProperties"), `sanitized schema must reach the wire, got: ${JSON.stringify(sent)}`);
});

test.after(() => {
  delete process.env.GEMINI_THINKING_BUDGET;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_EMBEDDING_DIMENSIONS;
  delete process.env.GEMINI_MAX_CONCURRENCY;
  delete process.env.GEMINI_MAX_RETRIES;
  delete process.env.GEMINI_MAX_BACKOFF_MS;
});
