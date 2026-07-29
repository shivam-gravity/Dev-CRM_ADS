import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert";
import { runAudienceIntelligence } from "../research/audience-intelligence/AudienceIntelligenceEngine.js";

// Isolated from audienceIntelligenceEngine.test.ts's no-key path — that file does a
// module-scope `delete process.env.GEMINI_API_KEY`, which freezes llmClient.ts's
// `llm` const as false for the lifetime of that module instance. If this test lived in the
// same file/process, a later re-population of the key (e.g. via another module's own
// "dotenv/config" import) would make a live-path test THINK it has a key (env check passes)
// while the already-frozen gate stays false underneath, silently falling back instead of
// exercising the real path — same isolation issue imageProvider.live.test.ts/
// metaAdapter.live.test.ts already solve by using a dedicated file.
test("runAudienceIntelligence - live path returns a structured ICP with weighted firmographic and behavioral criteria", async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.log("Skipping — GEMINI_API_KEY not set.");
    return;
  }
  const report = await runAudienceIntelligence({ workspaceId: `ws-icp-${Date.now()}`, url: "https://stripe.com", businessName: "Stripe" });

  if (report.confidence <= 0.1) {
    console.log("Skipping assertions — all LLM providers rate-limited or unavailable (fallback result).");
    return;
  }

  assert.ok(report.icp.summary.length > 0);
  assert.ok(report.icp.firmographics.length >= 2, "expected at least 2 firmographic fit criteria");
  assert.ok(report.icp.behavioralSignals.length >= 2, "expected at least 2 behavioral fit criteria");
  for (const c of [...report.icp.firmographics, ...report.icp.behavioralSignals]) {
    assert.ok(typeof c.criterion === "string" && c.criterion.length > 0);
    assert.ok(c.weight >= 0 && c.weight <= 1, `weight must be in [0,1], got ${c.weight}`);
  }

  // Regression test for a real bug: personas used to be reconstructed downstream by
  // zipping decisionMakers against motivations/buyingTriggers via `i % length`, which
  // visibly duplicated pain-point text and channel lists across different persona cards in
  // the UI. Each persona must now genuinely stand on its own.
  assert.ok(report.personas.length >= 3, "expected at least 3 distinct personas");
  const painPoints = report.personas.map((p) => p.painPoint);
  assert.strictEqual(new Set(painPoints).size, painPoints.length, "every persona's painPoint must be distinct");
  for (const p of report.personas) {
    assert.ok(p.role.length > 0);
    assert.ok(p.channels.length > 0, `persona "${p.role}" must have at least one channel`);
  }
});
