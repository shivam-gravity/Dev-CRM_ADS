import "dotenv/config";
import { test, after } from "node:test";
import assert from "node:assert";
import { runDecisionEngine } from "../research/decision/decision-engine.js";
import type { ResearchContext } from "../research/types/index.js";
import { disconnectTestInfra } from "./testUtils/disconnectInfra.js";

after(disconnectTestInfra);

/** A rich, real-world-shaped context for stripe.com — the same business this session's
 * Competitor/Audience/Creative/Pricing/Market/Landing-Page Intelligence engines were
 * live-verified against, so this exercises the live LLM path with genuinely representative
 * data rather than a synthetic toy business. */
function stripeContext(workspaceId: string): ResearchContext {
  return {
    jobId: "research-stripe", workspaceId, businessId: `biz-${workspaceId}`, url: "https://stripe.com",
    website: { title: "Stripe | Financial Infrastructure for the Internet", description: "Stripe powers online and in-person payment processing for internet businesses of all sizes.", excerpt: "Millions of companies of all sizes use Stripe.", images: [], crawledPages: ["https://stripe.com"], pagesDiscovered: 1, dataSource: "https://stripe.com" },
    market: { marketSize: "$100B+ global payments processing", growthRate: "12% CAGR", trends: ["embedded finance", "usage-based pricing", "AI fraud detection"], competitionLevel: "high, saturated with well-funded incumbents", dataSource: "test-fixture" },
    technology: null,
    competitors: { competitors: [{ name: "Square", url: "https://squareup.com" }, { name: "Adyen", url: "https://adyen.com" }, { name: "PayPal", url: "https://paypal.com" }], competitionIntensity: "highly saturated and fiercely competitive", differentiators: ["developer-first APIs", "global currency support"], dataSource: "test-fixture" },
    keywords: { primaryKeywords: ["payment processing", "online payments", "payment gateway", "billing infrastructure"], headings: ["Financial infrastructure for the internet"], dataSource: "test-fixture" },
    audience: { primaryAudience: "Engineering and product leaders at internet businesses integrating payments", segments: [{ name: "Startups", description: "Early-stage companies needing fast payment integration" }], painPoints: ["complex PCI compliance", "slow payouts", "poor developer docs from incumbents"], interestTags: ["fintech", "developer tools"], dataSource: "test-fixture" },
    company: { name: "Stripe", summary: "Stripe is a financial infrastructure platform for businesses of all sizes, offering payment processing, billing, and financial tooling via developer-first APIs.", foundedYear: "2010", headquarters: "San Francisco, CA", dataSource: "test-fixture" },
    news: { articles: [{ title: "Stripe expands stablecoin payment support", url: "https://stripe.com/newsroom" }], summary: "Stripe recently expanded stablecoin and embedded finance offerings.", dataSource: "test-fixture" },
    metadata: {
      jobId: "research-stripe", generatedAt: new Date().toISOString(), totalDurationMs: 1200,
      providersSucceeded: ["website", "market", "competitor", "seo", "audience", "company", "news"], providersPartial: [], providersFailed: [],
      confidenceByProvider: { website: 0.9, market: 0.7, competitor: 0.75, seo: 0.85, audience: 0.65, company: 0.7, news: 0.6 },
      overallConfidence: 0.74,
      fusion: {
        authorityByProvider: { website: 0.95, market: 0.65, competitor: 0.65, seo: 0.9, audience: 0.6, company: 0.65, news: 0.6 },
        fusedConfidenceByProvider: { website: 0.86, market: 0.46, competitor: 0.49, seo: 0.77, audience: 0.39, company: 0.46, news: 0.36 },
        overallFusedConfidence: 0.54,
        conflicts: [],
        explainability: [],
      },
    },
  };
}

test("runDecisionEngine - live end-to-end against real stripe.com research data produces a coherent, non-fallback DecisionContext", { skip: !process.env.GEMINI_API_KEY }, async () => {
  const workspaceId = `ws-decision-live-${Date.now()}`;
  const decision = await runDecisionEngine(stripeContext(workspaceId));

  assert.ok(!decision.businessSummary.includes("No live research"), "expected a real synthesized business summary");
  assert.ok(decision.recommendations.length >= 5, "expected multiple real recommendations");
  assert.strictEqual(decision.strategies.length, 3);
  assert.ok(decision.confidence > 0.2, `expected non-trivial confidence, got ${decision.confidence}`);
  assert.ok(decision.evidence.length > 0, "expected evidence traceable to real research fields");
  assert.ok(
    decision.explainability.every((e) => e.supportingProviders.length > 0),
    "every recommendation should trace back to at least one supporting provider"
  );
});
