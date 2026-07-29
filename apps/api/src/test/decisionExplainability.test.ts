import { test } from "node:test";
import assert from "node:assert";
import type { ResearchContext } from "../research/types/index.js";
import type { RankedRecommendation } from "../research/decision/types.js";

function fakeContext(overrides: Partial<ResearchContext> = {}): ResearchContext {
  return {
    jobId: "research-1", workspaceId: "ws-1", url: "https://example.com",
    website: null, market: null, technology: null, competitors: null, keywords: null, audience: null, company: null, news: null,
    metadata: { jobId: "research-1", generatedAt: new Date().toISOString(), totalDurationMs: 0, providersSucceeded: [], providersPartial: [], providersFailed: [], confidenceByProvider: {}, overallConfidence: 0.5 },
    ...overrides,
  };
}

function fakeRanked(overrides: Partial<RankedRecommendation> = {}): RankedRecommendation {
  return {
    id: "rec-1", title: "Sharpen positioning", category: "positioning", priority: "high", impact: "high",
    confidence: 0.6, reason: "because", evidence: ["Company: Acme sells widgets."], affectedAudience: "Everyone",
    estimatedDifficulty: "medium", expectedOutcome: "More sales",
    rankingFactors: { researchConfidence: 0.6, evidenceQuality: 0.5, sourceAuthority: 0.5, freshness: 1, businessRelevance: 0.5, crossProviderAgreement: 0.7, historicalSuccess: 0.5 },
    finalScore: 60,
    ...overrides,
  };
}

delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
const t = Date.now();
const { explainRecommendations } = await import(`../research/decision/explainability.js?t=${t}`);

test("explainRecommendations - supportingProviders lists only providers whose ResearchContext field is actually present", async () => {
  const context = fakeContext({ company: { name: "Acme", summary: "Acme sells widgets.", dataSource: "test" } });
  const [report] = await explainRecommendations(context, [fakeRanked()]);
  assert.deepStrictEqual(report.supportingProviders, ["company"]);
});

test("explainRecommendations - memoryReferences degrades to an empty array when Research Memory is unreachable (no OPENAI_API_KEY)", async () => {
  const [report] = await explainRecommendations(fakeContext(), [fakeRanked()]);
  assert.deepStrictEqual(report.memoryReferences, []);
});

test("explainRecommendations - conflictingInformation surfaces only Knowledge Fusion conflicts whose sources overlap this recommendation's providers", async () => {
  const context = fakeContext({
    company: { name: "Acme", summary: "Acme sells widgets.", dataSource: "test" },
    metadata: {
      jobId: "research-1", generatedAt: new Date().toISOString(), totalDurationMs: 0,
      providersSucceeded: [], providersPartial: [], providersFailed: [], confidenceByProvider: {}, overallConfidence: 0.5,
      fusion: {
        authorityByProvider: { company: 0.65 },
        fusedConfidenceByProvider: { company: 0.4 },
        overallFusedConfidence: 0.4,
        conflicts: [
          { kind: "low-grounding-despite-success", description: "company looks shaky", severity: "medium", sources: ["company"] },
          { kind: "low-grounding-despite-success", description: "audience looks shaky", severity: "medium", sources: ["audience"] },
        ],
        explainability: [],
      },
    },
  });
  const [report] = await explainRecommendations(context, [fakeRanked({ category: "positioning" })]);
  assert.deepStrictEqual(report.conflictingInformation, ["company looks shaky"]);
});

test("explainRecommendations - confidenceBreakdown/freshness/sourceAuthority mirror the recommendation's own rankingFactors", async () => {
  const ranked = fakeRanked();
  const [report] = await explainRecommendations(fakeContext(), [ranked]);
  assert.deepStrictEqual(report.confidenceBreakdown, ranked.rankingFactors);
  assert.strictEqual(report.freshness, ranked.rankingFactors.freshness);
  assert.strictEqual(report.sourceAuthority, ranked.rankingFactors.sourceAuthority);
});

test("explainRecommendations - evidence is passed through unchanged from the recommendation", async () => {
  const [report] = await explainRecommendations(fakeContext(), [fakeRanked()]);
  assert.deepStrictEqual(report.evidence, ["Company: Acme sells widgets."]);
});
