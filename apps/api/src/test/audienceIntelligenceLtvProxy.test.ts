import { test, after } from "node:test";
import assert from "node:assert";
import { disconnectTestInfra } from "./testUtils/disconnectInfra.js";

delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
process.env.SHOPIFY_STORE_DOMAIN = "ltv-test-store.myshopify.com";
process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "test-admin-token";

const { runAudienceIntelligence } = await import(`../research/audience-intelligence/AudienceIntelligenceEngine.js?t=${Date.now()}`);
const { connectIntegration } = await import("../modules/integrations/integrationService.js");

after(disconnectTestInfra);

test("runAudienceIntelligence - a connected Shopify catalog produces a real, non-fabricated estimatedLtvProxy", async () => {
  const workspaceId = `ws-ltv-test-${Date.now()}`;
  const businessId = `biz-ltv-test-${Date.now()}`;
  await connectIntegration(workspaceId, "shopify", "LTV Test Store");

  const original = global.fetch;
  global.fetch = (async (url: any) => {
    if (String(url).includes("ltv-test-store.myshopify.com")) {
      return {
        ok: true,
        json: async () => ({
          products: [
            { title: "Cheap Widget", product_type: "Widgets", variants: [{ price: "50.00" }], image: { src: "" }, handle: "cheap-widget" },
            { title: "Premium Widget", product_type: "Widgets", variants: [{ price: "150.00" }], image: { src: "" }, handle: "premium-widget" },
          ],
        }),
      } as Response;
    }
    throw new Error(`unexpected fetch in this test: ${String(url)}`);
  }) as typeof fetch;

  try {
    const report = await runAudienceIntelligence({ workspaceId, businessId, url: "https://example.com", businessName: "Example Co" });

    // (50 + 150) / 2 = $100 average order value = 10000 cents — a real number derived from
    // the mocked catalog fetch above, not a placeholder.
    assert.strictEqual(report.estimatedLtvProxy.estimatedOrderValueCents, 10000);
    // No campaigns exist for this fresh businessId, so the conversion-rate signal is
    // genuinely absent — this must not be papered over with a fake number.
    assert.strictEqual(report.estimatedLtvProxy.conversionRateSignal, null);
    assert.strictEqual(report.estimatedLtvProxy.basis, "catalog-only");
    assert.ok(report.estimatedLtvProxy.score > 0);
  } finally {
    global.fetch = original;
  }
});

test("runAudienceIntelligence - with no businessId at all, the LTV proxy is honestly insufficient-data rather than attempting any lookup", async () => {
  const report = await runAudienceIntelligence({ workspaceId: "ws-no-business-id", url: "https://example.com" });
  assert.deepStrictEqual(report.estimatedLtvProxy, {
    estimatedOrderValueCents: null,
    conversionRateSignal: null,
    score: 0,
    basis: "insufficient-data",
  });
});
