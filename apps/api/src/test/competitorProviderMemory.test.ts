import { test } from "node:test";
import assert from "node:assert";

delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;

// Deleting the Gemini key can be load-order-fragile (an earlier test file may have already
// frozen llmClient.ts's `llm` gate). Blocking `global.fetch` at the module level, before the
// dynamic import below, makes "no live model call can succeed" deterministic. The import itself
// must stay dynamic (cache-busted) — a static import would be hoisted ahead of both the deletes
// and the fetch override.
let currentFetchImpl: typeof fetch = (async () => {
  throw new Error("network unavailable (simulated)");
}) as typeof fetch;
global.fetch = ((...args: Parameters<typeof fetch>) => currentFetchImpl(...args)) as typeof fetch;

const t = Date.now();
const { CompetitorProvider } = await import(`../research/providers/CompetitorProvider.js?t=${t}`);

test("CompetitorProvider - with no LLM provider configured, Research Memory is skipped entirely and the provider still degrades to its labeled fallback", async () => {
  const provider = new CompetitorProvider();
  const result = await provider.execute({ jobId: "job-1", workspaceId: "ws-1", businessId: "biz-1", url: "https://example.com" });

  // No live search, no embeddings possible without a key — this must be the same
  // no-key fallback shape CompetitorProvider had before Research Memory existed.
  assert.strictEqual(result.status, "partial");
  assert.strictEqual(result.data?.competitors[0]?.name, "Other providers in this category");
  assert.strictEqual(result.citations.length, 0);
});
