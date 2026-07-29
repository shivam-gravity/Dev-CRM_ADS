import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";

// writeMemory/readMemory embed their content via Gemini (llmClient.createEmbedding ->
// geminiClient.createEmbedding), which reads GEMINI_API_KEY + the global LLM-usage
// ledger at MODULE LOAD. On CI there are no Gemini creds, so createEmbedding threw and writeMemory
// hit its graceful-skip path (returns {id:"", deduped:false}) — making every write-path assertion
// here fail on a fresh runner while passing on a dev box that has real creds. Make the test hermetic:
// set a fake Gemini token, opt the usage boundary out of the way (explicit huge budget + a temp
// ledger so we never touch the real one or trip the monthly cap), and install a stable fetch
// indirection that returns a deterministic unit embedding. All read at load time, so they MUST be
// set before the dynamic import below — same constraint/pattern as geminiClient.test.ts.
process.env.LLM_MONTHLY_TOKEN_BUDGET = String(Number.MAX_SAFE_INTEGER);
process.env.LLM_USAGE_LEDGER_PATH = path.join(os.tmpdir(), "polluxa-memcoord-test-usage.json");
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.GEMINI_EMBEDDING_DIMENSIONS = "8";

// A fixed unit-length 8-dim vector — the exact value is irrelevant to these dedup/TTL tests (they
// never assert on similarity scores), it only needs to be a valid embedding so writeMemory persists.
// Unit length also means geminiClient's normalization pass leaves it untouched, so what the store
// receives is exactly this.
const FAKE_EMBEDDING = [1, 0, 0, 0, 0, 0, 0, 0];

global.fetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = String(input);
  // Gemini's embedContent endpoint. The response nests the vector under embedding.values — NOT a
  // bare embedding array. Returning the wrong shape makes createEmbedding resolve null, which
  // surfaces as writeMemory's graceful-skip path and fails every write assertion here with a
  // misleading "GEMINI_API_KEY is not set" message.
  if (url.includes(":embedContent")) {
    return new Response(JSON.stringify({ embedding: { values: FAKE_EMBEDDING } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`memoryCoordinator.test.ts: unexpected fetch to ${url}`);
}) as typeof fetch;

const { findExistingByDedupKey, getMetadataByDedupKey, readMemory, writeMemory } = await import("../research/memory/MemoryCoordinator.js");

test("writeMemory - creates a new entry the first time, then updates (deduped) on a repeat write for the same dedupKey", async () => {
  const workspaceId = `ws-memcoord-${Date.now()}`;

  const first = await writeMemory({
    workspaceId, kind: "audience-profile", sourceUrl: "https://example.com", dedupKey: "acme-corp",
    content: "Acme Corp targets SMBs.", metadata: { icp: "SMBs" },
  });
  assert.strictEqual(first.deduped, false);

  const second = await writeMemory({
    workspaceId, kind: "audience-profile", sourceUrl: "https://example.com", dedupKey: "acme-corp",
    content: "Acme Corp targets mid-market.", metadata: { icp: "Mid-market" },
  });
  assert.strictEqual(second.deduped, true);
  assert.strictEqual(second.id, first.id, "a repeat write for the same dedupKey must update the SAME row, not create a new one");

  const metadata = await getMetadataByDedupKey("audience-profile", workspaceId, "acme-corp");
  assert.strictEqual(metadata?.icp, "Mid-market", "the update must have overwritten the old metadata");
});

test("writeMemory - different dedupKeys under the same kind/workspace create separate entries", async () => {
  const workspaceId = `ws-memcoord-${Date.now()}`;

  const a = await writeMemory({ workspaceId, kind: "market-profile", sourceUrl: "https://a.com", dedupKey: "biz-a", content: "Market for A", metadata: {} });
  const b = await writeMemory({ workspaceId, kind: "market-profile", sourceUrl: "https://b.com", dedupKey: "biz-b", content: "Market for B", metadata: {} });

  assert.notStrictEqual(a.id, b.id);
});

test("findExistingByDedupKey / getMetadataByDedupKey - return nothing for a dedupKey that was never written", async () => {
  const workspaceId = `ws-memcoord-${Date.now()}`;
  assert.strictEqual(await findExistingByDedupKey("pricing-analysis", workspaceId, "nonexistent"), null);
  assert.strictEqual(await getMetadataByDedupKey("pricing-analysis", workspaceId, "nonexistent"), undefined);
});

test("writeMemory - stores dedupKey inside metadata alongside caller-provided fields", async () => {
  const workspaceId = `ws-memcoord-${Date.now()}`;
  await writeMemory({ workspaceId, kind: "creative-analysis", sourceUrl: "https://example.com", dedupKey: "acme", content: "text", metadata: { tone: "playful" } });

  const metadata = await getMetadataByDedupKey("creative-analysis", workspaceId, "acme");
  assert.strictEqual(metadata?.tone, "playful");
  assert.strictEqual(metadata?.dedupKey, "acme");
});

test("readMemory - applies a per-kind default TTL so a query still returns fresh, unrelated-kind default doesn't leak in", async () => {
  const workspaceId = `ws-memcoord-${Date.now()}`;
  await writeMemory({ workspaceId, kind: "pricing-analysis", sourceUrl: "https://example.com", dedupKey: "acme", content: "Acme pricing starts at $50/mo", metadata: { startingPriceUsd: 50 } });

  const matches = await readMemory({ kind: "pricing-analysis", queryText: "Acme pricing", workspaceId, topK: 5, minScore: 0 });
  assert.ok(matches.length >= 1);
  assert.strictEqual(matches[0].freshness, 1, "a just-written entry must be fully fresh under its kind's default TTL");
});
