import type { ChatMessage, JsonSchemaTool } from "./llmTypes.js";
import { recordTokens } from "./tokenMeter.js";
import { assertGlobalLlmUsageAvailable, recordGlobalLlmUsage } from "./llmUsageBoundary.js";
import { logger } from "../modules/logger/logger.js";

// Google Gemini via the Generative Language REST API, hit with PLAIN FETCH — no @google/genai
// dependency. An earlier revision of this file used that SDK; going back to raw fetch keeps the
// single LLM backend dependency-free and means the request/response shapes below are the whole
// contract, with nothing hidden in a client library that can change under us.
//
// Auth is the AI Studio API key. It goes in the x-goog-api-key HEADER rather than the documented
// `?key=` query parameter so the secret never lands in a URL — URLs get logged by proxies, error
// handlers, and our own fetch-failure messages, and a leaked Gemini key is a billable credential.
//
// Gated behind GEMINI_API_KEY: no key means every call below returns a clean `null` and
// llmClient/llmRouter surface that as "not configured" rather than throwing from deep inside.
//
// RATE LIMITS ARE THE MAIN OPERATIONAL RISK. Gemini's limits are PER-MINUTE, and the research
// pipeline fans out ~45 calls at once, so a naive burst trips HTTP 429 RESOURCE_EXHAUSTED and
// whole research legs score 0. Two guards, carried over from the previously live-verified
// revision of this client:
//   1) a concurrency limiter (never more than GEMINI_MAX_CONCURRENCY requests in flight), and
//   2) retry-with-backoff on 429/5xx honoring Retry-After, so a throttled call waits and
//      succeeds instead of failing instantly.
// The backoff cap is deliberately high (30s): a per-minute quota can take most of a minute to
// reset, and burning all retries inside that minute is how a leg fails for no reason.
//
// MODEL CHOICE MATTERS MORE THAN IT LOOKS. Some published model ids report a quota limit of 0 on
// AI Studio keys while the `-latest` aliases carry real working quota, so the default is the
// alias rather than a pinned version. Override with GEMINI_MODEL once you've confirmed a specific
// version has quota on your key.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_DEFAULT_MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-latest";
const GEMINI_API_BASE = process.env.GEMINI_API_BASE ?? "https://generativelanguage.googleapis.com/v1beta";

// Embeddings backend for Research Memory / RAG. 1024 dims is not arbitrary: ResearchMemoryStore
// compares fixed-width vectors with app-side cosine similarity, and 1024 is what the store was
// built around — keeping that width means switching embedding providers needs no schema change.
// gemini-embedding-001 supports reduced output dimensionality, so we ask for 1024 directly.
//
// Vectors from a DIFFERENT embedding model are mathematically incomparable to these even at the
// same width, so stored embeddings must be cleared and re-generated when this model changes.
// See scripts/reembed-research-memory.ts.
const GEMINI_EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001";
const GEMINI_EMBEDDING_DIMENSIONS = Math.max(1, Number(process.env.GEMINI_EMBEDDING_DIMENSIONS ?? 1024));
// One task type for both stored documents and queries. Gemini offers asymmetric
// RETRIEVAL_DOCUMENT/RETRIEVAL_QUERY types, but createEmbedding() has a single signature used for
// both sides of the comparison, and mixing the two types across a similarity pair degrades the
// score. SEMANTIC_SIMILARITY is the symmetric option, so both sides stay in the same space.
const GEMINI_EMBEDDING_TASK_TYPE = process.env.GEMINI_EMBEDDING_TASK_TYPE ?? "SEMANTIC_SIMILARITY";

// THINKING TOKENS ARE DRAWN FROM THE SAME BUDGET AS THE ANSWER. Gemini's current models reason
// before answering, and those "thought" tokens count against maxOutputTokens — so a caller's
// maxTokens is NOT the output budget it looks like. Verified live against gemini-flash-latest:
//   maxOutputTokens=32  -> finishReason MAX_TOKENS, thoughtsTokenCount 29, NO parts at all
//   maxOutputTokens=800 -> finishReason STOP,       thoughtsTokenCount 80, text "GEMINI_OK"
// The 32-token call spent its whole budget thinking and returned nothing. That is the dangerous
// failure mode here: it is not an error, it is an empty success, and every caller in this pipeline
// treats an empty result as "this leg produced nothing" — so tight budgets would silently degrade
// research quality with nothing in the logs. Every maxTokens in llmTaskConfig.ts was tuned against
// a backend with no thinking overhead, so preserving those numbers matters.
//
// Fix: give thinking its OWN budget and ADD it to what the caller asked for, so the caller's
// maxTokens is entirely available for visible output and the accounting is deterministic
// (thinking <= GEMINI_THINKING_BUDGET, output <= opts.maxTokens).
//
// Note you cannot simply switch thinking off: thinkingBudget:0 is rejected with HTTP 400
// INVALID_ARGUMENT on this model. It can only be capped. Set GEMINI_THINKING_BUDGET to 0 (or any
// value <= 0) to omit the cap entirely and let the model budget its own thinking — in which case
// maxOutputTokens gets no headroom and tight-budget callers can starve again.
const GEMINI_THINKING_BUDGET = Number(process.env.GEMINI_THINKING_BUDGET ?? 1024);

const GEMINI_MAX_CONCURRENCY = Math.max(1, Number(process.env.GEMINI_MAX_CONCURRENCY ?? 4));
const GEMINI_MAX_RETRIES = Math.max(0, Number(process.env.GEMINI_MAX_RETRIES ?? 6));
const GEMINI_BASE_BACKOFF_MS = 500;
const GEMINI_MAX_BACKOFF_MS = Number(process.env.GEMINI_MAX_BACKOFF_MS ?? 30_000);

function generateContentUrl(model: string): string {
  return `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
}

function embedContentUrl(model: string): string {
  return `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:embedContent`;
}

function headers(): Record<string, string> {
  return { "x-goog-api-key": GEMINI_API_KEY as string, "Content-Type": "application/json" };
}

let geminiInFlight = 0;
const geminiWaiters: (() => void)[] = [];

async function acquireGeminiSlot(): Promise<void> {
  if (geminiInFlight < GEMINI_MAX_CONCURRENCY) {
    geminiInFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => geminiWaiters.push(resolve));
  geminiInFlight += 1;
}

function releaseGeminiSlot(): void {
  geminiInFlight -= 1;
  const next = geminiWaiters.shift();
  if (next) next();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff for retry attempt N (0-based): honor a server Retry-After (seconds) when present, else
 * exponential (500ms, 1s, 2s…) capped, with deterministic jitter (no Math.random in this codebase). */
function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, GEMINI_MAX_BACKOFF_MS);
  const expo = Math.min(GEMINI_BASE_BACKOFF_MS * 2 ** attempt, GEMINI_MAX_BACKOFF_MS);
  return expo + Math.floor((expo / 2) * ((geminiInFlight % 7) / 7));
}

/** Fetch with the concurrency slot held, retrying 429 (RESOURCE_EXHAUSTED), 5xx, AND thrown
 * network errors with backoff. Non-retryable 4xx (400/403/404) throw immediately.
 * Returns the successful Response. */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  await acquireGeminiSlot();
  try {
    let lastErrText = "";
    for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
      // A CONNECTION-LEVEL failure makes fetch() THROW rather than return a status — Node surfaces
      // DNS failures, resets, and connect timeouts as `TypeError: fetch failed`. That threw straight
      // out of this loop before, so the status-based retry below never saw it and one transient blip
      // permanently failed that agent/provider (observed live: three agents lost to `fetch failed`
      // seconds apart, each degrading to its template fallback). A dropped connection is at least as
      // transient as the 429/5xx we already retry, so it gets the same backoff.
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt === GEMINI_MAX_RETRIES) throw new Error(`Gemini request failed (network): ${message}`);
        const wait = backoffMs(attempt, null);
        logger.warn(`geminiClient: network error "${message}" — retrying in ${wait}ms (attempt ${attempt + 1}/${GEMINI_MAX_RETRIES})`);
        await sleep(wait);
        continue;
      }
      if (res.ok) return res;

      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!retryable || attempt === GEMINI_MAX_RETRIES) {
        throw new Error(`Gemini request failed (${res.status}): ${await res.text()}`);
      }
      lastErrText = `${res.status}`;
      const wait = backoffMs(attempt, res.headers.get("retry-after"));
      logger.warn(`geminiClient: ${lastErrText} (throttled/transient) — retrying in ${wait}ms (attempt ${attempt + 1}/${GEMINI_MAX_RETRIES})`);
      await sleep(wait);
    }
    throw new Error(`Gemini request failed after retries: ${lastErrText}`);
  } finally {
    releaseGeminiSlot();
  }
}

// ── generateContent request/response shapes (only the fields we use) ──
interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: unknown };
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

/**
 * JSON Schema keywords Gemini's Schema proto does not define. Sending any of them makes the
 * WHOLE request fail with 400 INVALID_ARGUMENT ("Unknown name X: Cannot find field") — the
 * request is rejected wholesale, not the offending keyword ignored, so one stray keyword deep
 * in a nested schema takes out the entire call.
 *
 * `additionalProperties` is the one that bit us in production: it expresses an open-ended map
 * (`budgetSplit: {[network]: number}`), which the proto simply cannot represent. Dropping the
 * keyword is the only translation available — see sanitizeGeminiSchema for why callers that
 * need a real map should declare explicit properties instead.
 */
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "patternProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "allOf",
  "oneOf",
  "not",
  "const",
  "examples",
  "if",
  "then",
  "else",
]);

/**
 * Translate a JSON Schema into the restricted OpenAPI-3 subset Gemini's
 * `FunctionDeclaration.parameters` actually accepts.
 *
 * This exists because a rejected schema is INVISIBLE at the call site: llmRouter logs the 400
 * as a warning and returns null, the agent falls back to its hardcoded template, and the
 * AgentResult records `usedFallback: true` with NO error — so the pipeline keeps producing
 * plausible-looking-but-generic output forever. Two real cases were live in production:
 *
 *   StrategyAgent's `budgetSplit`      -> `additionalProperties` -> "Unknown name ... Cannot find field"
 *   PricingIntelligence's `startingPriceUsd` -> `type: ["number","null"]` -> "Proto field is not
 *                                               repeating, cannot start list"
 *
 * The first silently degraded campaign/audience/keyword/budget on EVERY campaign generation.
 * Translating here (rather than only fixing those two schemas) means the next hand-written
 * schema with a nullable union or an open map degrades gracefully instead of killing the call.
 *
 * Two transformations, applied recursively through `properties`/`items`/`anyOf`:
 *  - a union `type` array collapses to its first non-"null" entry, with `"null"` present
 *    becoming `nullable: true` — the proto's `type` is a single enum value, and nullability is
 *    its own boolean field;
 *  - unsupported keywords are dropped.
 *
 * Note the deliberate limitation on dropped `additionalProperties`: an object left with no
 * `properties` becomes an untyped object, and Gemini tends to return `{}` for it. That is a
 * quality loss, not a hard failure — so a schema that genuinely needs a map should enumerate
 * its keys explicitly (as StrategyAgent's budgetSplit now does) rather than rely on this.
 */
export function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (schema === null || typeof schema !== "object") return schema;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;

    if (key === "type" && Array.isArray(value)) {
      const types = value.filter((t): t is string => typeof t === "string");
      const concrete = types.find((t) => t !== "null");
      // An all-"null" type has no proto representation at all; omit `type` entirely and let
      // Gemini treat the field as untyped rather than send a value it will reject.
      if (concrete) out.type = concrete;
      if (types.includes("null")) out.nullable = true;
      continue;
    }

    out[key] = sanitizeGeminiSchema(value);
  }
  return out;
}

/**
 * Gemini's generateContent. Three shape quirks are worth naming, because each one silently
 * produces empty results rather than an error when you get it wrong:
 *  - the assistant role is called "model", not "assistant", so ChatMessage roles are mapped;
 *  - the system prompt is `systemInstruction`, not a `system` array;
 *  - structured output is a FUNCTION CALL, forced with
 *    toolConfig.functionCallingConfig.mode="ANY" + allowedFunctionNames — the equivalent of
 *    Converse's toolChoice.tool. Without ANY-mode the model may answer in prose and ignore the
 *    schema, which is what makes every structured caller in the pipeline return null.
 * The forced-function-call mode is also why `tool.input_schema` maps to `parameters` rather than
 * to Gemini's separate responseSchema/JSON-mode feature — the callers all expect a tool shape.
 */
async function generateContent(opts: {
  model: string;
  maxTokens: number;
  system?: string;
  messages: ChatMessage[];
  tool?: JsonSchemaTool;
}): Promise<GenerateContentResponse | null> {
  if (!GEMINI_API_KEY) return null;
  assertGlobalLlmUsageAvailable();

  // See GEMINI_THINKING_BUDGET: the caller's maxTokens is the OUTPUT budget, and thinking gets its
  // own allowance on top, so a small maxTokens can't be consumed entirely by thought tokens.
  const capThinking = Number.isFinite(GEMINI_THINKING_BUDGET) && GEMINI_THINKING_BUDGET > 0;

  const body: Record<string, unknown> = {
    contents: opts.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    generationConfig: {
      maxOutputTokens: opts.maxTokens + (capThinking ? GEMINI_THINKING_BUDGET : 0),
      ...(capThinking ? { thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET } } : {}),
    },
    ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
    ...(opts.tool
      ? {
          tools: [
            {
              functionDeclarations: [
                { name: opts.tool.name, description: opts.tool.description, parameters: sanitizeGeminiSchema(opts.tool.input_schema) },
              ],
            },
          ],
          toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [opts.tool.name] } },
        }
      : {}),
  };

  const res = await fetchWithRetry(generateContentUrl(opts.model), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  return (await res.json()) as GenerateContentResponse;
}

/**
 * Explains an empty result when the token budget was the cause. A thinking model can spend the
 * entire budget on thought tokens and return a candidate with NO parts — an empty SUCCESS, not an
 * error. Every caller here treats empty as "this leg produced nothing", so without this line the
 * degradation is completely invisible. Naming the actual numbers makes the remedy obvious (raise
 * this task's maxTokens, or raise GEMINI_THINKING_BUDGET) instead of sending someone hunting.
 */
function warnIfBudgetStarved(where: string, model: string, maxTokens: number, response: GenerateContentResponse): void {
  if (response.candidates?.[0]?.finishReason !== "MAX_TOKENS") return;
  const thoughts = response.usageMetadata?.thoughtsTokenCount ?? 0;
  const output = response.usageMetadata?.candidatesTokenCount ?? 0;
  logger.warn(
    `geminiClient.${where}: ${model} returned NO usable output — finishReason=MAX_TOKENS ` +
      `(thinking used ${thoughts} tokens, visible output ${output}; caller asked for maxTokens=${maxTokens}, ` +
      `thinking allowance=${GEMINI_THINKING_BUDGET}). Raise this task's maxTokens or GEMINI_THINKING_BUDGET.`
  );
}

function recordUsage(model: string, kind: "structured" | "text", response: GenerateContentResponse): void {
  const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
  recordTokens({ provider: "gemini", model, kind, inputTokens, outputTokens });
  recordGlobalLlmUsage(inputTokens + outputTokens);
}

export async function runStructured<T>(opts: {
  model?: string;
  maxTokens: number;
  system?: string;
  messages: ChatMessage[];
  tool: JsonSchemaTool;
}): Promise<T | null> {
  const model = opts.model ?? GEMINI_DEFAULT_MODEL;
  const response = await generateContent({ model, maxTokens: opts.maxTokens, system: opts.system, messages: opts.messages, tool: opts.tool });
  if (!response) return null;

  recordUsage(model, "structured", response);

  // A safety block returns no candidates at all rather than an HTTP error — surface it as null
  // (the "this task produced nothing" contract every caller already handles) but log the reason,
  // because a silent null here is otherwise indistinguishable from a schema mismatch.
  if (response.promptFeedback?.blockReason) {
    logger.warn(`geminiClient.runStructured: prompt blocked (${response.promptFeedback.blockReason}) — no result`);
    return null;
  }

  // functionCall.args is already-parsed JSON (the REST API hands back a structured object, so no
  // JSON.parse needed — same as Converse's toolUse.input).
  const call = response.candidates?.[0]?.content?.parts?.find((p) => p.functionCall)?.functionCall;
  if (!call || call.args == null) {
    warnIfBudgetStarved("runStructured", model, opts.maxTokens, response);
    return null;
  }
  return call.args as T;
}

/** Plain chat completion, no tools — returns the assistant's text, or null if empty. */
export async function runText(opts: { model?: string; maxTokens: number; system?: string; messages: ChatMessage[] }): Promise<string | null> {
  const model = opts.model ?? GEMINI_DEFAULT_MODEL;
  const response = await generateContent({ model, maxTokens: opts.maxTokens, system: opts.system, messages: opts.messages });
  if (!response) return null;

  recordUsage(model, "text", response);

  if (response.promptFeedback?.blockReason) {
    logger.warn(`geminiClient.runText: prompt blocked (${response.promptFeedback.blockReason}) — no result`);
    return null;
  }

  // Concatenate every text part (a long answer can be split across parts); null if none.
  const text = response.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
  if (!text) {
    warnIfBudgetStarved("runText", model, opts.maxTokens, response);
    return null;
  }
  return text;
}

export function isGeminiConfigured(): boolean {
  return GEMINI_API_KEY !== undefined && GEMINI_API_KEY.length > 0;
}

// ── Embeddings (embedContent) ──
interface EmbedContentResponse {
  embedding?: { values?: number[] };
}

/**
 * Single-text embedding for Research Memory / RAG. Returns the vector, or null when Gemini isn't
 * configured — the same "not configured → null" contract the chat calls use, so callers treat it
 * uniformly.
 *
 * The vector is L2-NORMALIZED here. Gemini only returns unit-length vectors at its native 3072
 * dimensions; any reduced outputDimensionality (we ask for 1024) comes back UN-normalized, and
 * ResearchMemoryStore's app-side cosine similarity assumes unit vectors so it can use a plain dot
 * product. Normalizing at the boundary keeps that assumption true and means the store needs no
 * change. A zero-magnitude vector would make this a divide-by-zero, so that degenerate case
 * returns null instead of NaNs that would silently poison every later similarity comparison.
 */
export async function createEmbedding(text: string): Promise<number[] | null> {
  if (!GEMINI_API_KEY) return null;
  assertGlobalLlmUsageAvailable();

  const res = await fetchWithRetry(embedContentUrl(GEMINI_EMBEDDING_MODEL), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      content: { parts: [{ text }] },
      taskType: GEMINI_EMBEDDING_TASK_TYPE,
      outputDimensionality: GEMINI_EMBEDDING_DIMENSIONS,
    }),
  });
  const json = (await res.json()) as EmbedContentResponse;
  const values = json.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) return null;

  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    logger.warn("geminiClient.createEmbedding: zero-magnitude vector — treating as no embedding");
    return null;
  }
  const normalized = values.map((v) => v / magnitude);

  // embedContent reports no token counts, so record the call with zeroed counts — it still shows
  // up in end-to-end profiling alongside chat, which is the point of the meter.
  recordTokens({ provider: "gemini", model: GEMINI_EMBEDDING_MODEL, kind: "embedding", inputTokens: 0, outputTokens: 0 });
  return normalized;
}

/** Width of the vectors createEmbedding returns — read by the re-embed script so the expected
 * dimension lives in one place rather than being duplicated as a literal. */
export function embeddingDimensions(): number {
  return GEMINI_EMBEDDING_DIMENSIONS;
}
