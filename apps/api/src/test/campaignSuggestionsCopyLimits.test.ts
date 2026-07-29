import { test } from "node:test";
import assert from "node:assert";

// generateCampaignSuggestions's fallback path (no LLM configured) is what this test exercises
// — deterministic, no network mocking needed, and it's the same code path real callers hit
// whenever there's no live model available. The LLM gate is Gemini, so scrub its token.
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;

const { generateCampaignSuggestions } = await import("../modules/strategy/strategyEngine.js");
import type { ResearchStrategyInput } from "../modules/strategy/strategyEngine.js";
import { PLATFORM_COPY_LIMITS } from "../modules/strategy/platformCopyLimits.js";

const LONG_NAME = "The Extremely Long Product Name That Exceeds Every Ad Network's Headline Limit By A Wide Margin";

function fakeInput(): ResearchStrategyInput {
  return {
    product: { productName: LONG_NAME, category: "Widgets", summary: "A widget.", valueProposition: "Fast widgets.", keyFeatures: ["Fast"] },
    audience: { primaryAudience: "SMB owners", segments: [], painPoints: [], buyingMotivations: [] },
    competitorBudget: { competitors: [], competitionIntensity: "Moderate", differentiators: [], budgetReasoning: [], recommendedDailyBudgetCents: 5000, dataSource: "test" },
    marketLocation: { recommendedRegion: "US", alternativeRegions: [], marketTrends: "Growing", competitionLevel: "Moderate", recommendedPlatform: "google", placementRationale: "n/a", dataSource: "test" },
    personas: [{ name: "SMB Owner", ageRange: "30-50", genderSplit: "n/a", details: "n/a", interests: ["widgets"] }],
  };
}

test("generateCampaignSuggestions (fallback path) - meta suggestions respect Meta's real headline limit, google suggestions respect Google's stricter one", async () => {
  const suggestions = await generateCampaignSuggestions(fakeInput());

  const metaSuggestions = suggestions.filter((s) => s.platform === "meta");
  const googleSuggestions = suggestions.filter((s) => s.platform === "google");
  assert.ok(metaSuggestions.length > 0);
  assert.ok(googleSuggestions.length > 0);

  for (const s of metaSuggestions) {
    assert.ok(s.headline.length <= PLATFORM_COPY_LIMITS.meta.headline, `meta headline "${s.headline}" exceeds ${PLATFORM_COPY_LIMITS.meta.headline} chars`);
  }
  for (const s of googleSuggestions) {
    assert.ok(s.headline.length <= PLATFORM_COPY_LIMITS.google.headline, `google headline "${s.headline}" exceeds ${PLATFORM_COPY_LIMITS.google.headline} chars`);
  }

  // Same source product name feeding both platforms' first suggestion — Google's stricter
  // limit must produce a shorter (or equally, never longer) result than Meta's.
  assert.ok(googleSuggestions[0].headline.length <= metaSuggestions[0].headline.length);
});
