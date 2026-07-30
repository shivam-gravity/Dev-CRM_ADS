import { z } from "zod";
import type { AIAgent } from "../interfaces/AIAgent.js";
import { loadVerifiedFacts, verifiedFactsForPrompt } from "../crawlFacts.js";
import { callAgentModel, collectEvidence, computeConfidence, runAgentStep } from "../support.js";
import type { AgentResult, ResearchContext, StrategyAgentOutput } from "../types/index.js";

const NETWORK_ENUM = ["meta", "google", "tiktok"] as const;

/**
 * Composite producer super-agent — does campaign-agent + audience-agent (incl. personas) +
 * keyword-agent + budget-agent's jobs in ONE structured LLM call. Its bundled result is
 * exploded back into the legacy `results["campaign-agent"]`/`["audience-agent"]`/etc. keys by
 * AgentCoordinator.deriveLegacyAgentResults, so nothing downstream changes. The nested tool
 * shape mirrors each individual agent's tool exactly, so the model produces the same fields.
 */
const STRATEGY_AGENT_TOOL = {
  name: "emit_strategy_agent_result",
  description: "Return the full campaign strategy, audience+personas, keyword plan, and budget in one structured result.",
  input_schema: {
    type: "object" as const,
    properties: {
      campaign: {
        type: "object",
        properties: {
          summary: { type: "string", description: "2-3 sentence strategy overview" },
          recommendedNetworks: { type: "array", items: { type: "string", enum: [...NETWORK_ENUM] }, minItems: 1, maxItems: 3 },
          // Networks are a fixed enum, so the split is declared as explicit properties rather than
          // an open `additionalProperties` map — Gemini's function-declaration proto has no such
          // field and REJECTS THE WHOLE CALL with 400 INVALID_ARGUMENT when it appears, which
          // silently degraded this composite agent (and with it campaign/audience/keyword/budget)
          // to its template fallback on every run. Mirrors emit_ad_strategy in strategy/strategyEngine.ts.
          budgetSplit: {
            type: "object",
            properties: { meta: { type: "number" }, google: { type: "number" }, tiktok: { type: "number" } },
            required: ["meta", "google"],
            description: "Fractions per network that sum to 1, e.g. {\"meta\": 0.6, \"google\": 0.4}",
          },
          audiences: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
          creatives: {
            type: "array",
            description: "4-6 distinct ad concepts — vary the angle (feature, offer, social proof, urgency, pain point, comparison) so every one reads as a genuinely different ad. Quality over quantity: the campaign surfaces only the top few, so make each one strong.",
            minItems: 4,
            maxItems: 6,
            items: { type: "object", properties: { headline: { type: "string" }, body: { type: "string" }, callToAction: { type: "string" } }, required: ["headline", "body", "callToAction"] },
          },
        },
        required: ["summary", "recommendedNetworks", "budgetSplit", "audiences", "creatives"],
      },
      audience: {
        type: "object",
        properties: {
          primaryAudience: { type: "string" },
          segments: { type: "array", minItems: 1, maxItems: 5, items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } }, required: ["name", "description"] } },
          painPoints: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
          interestTags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
          targetingNotes: { type: "string", description: "1-2 sentences of practical ad-targeting guidance" },
          personas: {
            type: "array",
            minItems: 2,
            maxItems: 6,
            description: "Named audience personas, each with real Meta-ads interest keywords — one per distinct buyer segment",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "e.g. \"Growth-Focused CMO\"" },
                ageRange: { type: "string", description: "e.g. \"35-55\"" },
                genderSplit: { type: "string", description: "e.g. \"60% Male, 40% Female\"" },
                details: { type: "string", description: "1-2 sentences on who this persona is and why they convert" },
                interests: { type: "array", items: { type: "string" }, minItems: 6, maxItems: 15, description: "Real Meta Ads interest keywords (brands, job titles, tools) — not generic terms" },
              },
              required: ["name", "ageRange", "genderSplit", "details", "interests"],
            },
          },
        },
        required: ["primaryAudience", "segments", "painPoints", "interestTags", "targetingNotes", "personas"],
      },
      keyword: {
        type: "object",
        properties: {
          primaryKeywords: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 15 },
          adGroupSuggestions: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8, description: "Suggested ad-group themes/names" },
          negativeKeywords: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 10 },
        },
        required: ["primaryKeywords", "adGroupSuggestions", "negativeKeywords"],
      },
      budget: {
        type: "object",
        properties: {
          recommendedDailyBudgetCents: { type: "integer", description: "GROWTH-tier daily budget in cents (e.g. 15000 for $150/day)" },
          testBudgetCents: { type: "integer", description: "Minimum viable TEST-tier daily budget in cents" },
          scaleBudgetCents: { type: "integer", description: "Aggressive SCALE-tier daily budget in cents" },
          platformSplit: {
            type: "object",
            properties: {
              meta: { type: "integer", description: "Percentage allocated to Meta Ads (0-100)" },
              google: { type: "integer", description: "Percentage allocated to Google Ads (0-100)" },
              tiktok: { type: "integer", description: "Percentage allocated to TikTok (0-100)" },
            },
            required: ["meta", "google"],
          },
          reasoning: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 8, description: "Step-by-step: vertical -> CPC benchmarks -> clicks needed -> tiers -> split rationale" },
          expectedOutcomes: {
            type: "object",
            properties: {
              dailyClicks: { type: "integer" },
              dailyImpressions: { type: "integer" },
              estimatedCPACents: { type: "integer" },
              estimatedROAS: { type: "number" },
              monthlyConversions: { type: "integer" },
            },
          },
          riskFactors: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 5 },
        },
        required: ["recommendedDailyBudgetCents", "reasoning", "riskFactors"],
      },
    },
    required: ["campaign", "audience", "keyword", "budget"],
  },
};

const strategyAgentSchema: z.ZodType<StrategyAgentOutput> = z.object({
  campaign: z.object({
    summary: z.string(),
    recommendedNetworks: z.array(z.enum(NETWORK_ENUM)),
    budgetSplit: z.record(z.number()),
    audiences: z.array(z.string()),
    creatives: z.array(z.object({ headline: z.string(), body: z.string(), callToAction: z.string() })),
  }),
  audience: z.object({
    primaryAudience: z.string(),
    segments: z.array(z.object({ name: z.string(), description: z.string() })),
    painPoints: z.array(z.string()),
    interestTags: z.array(z.string()),
    targetingNotes: z.string(),
    personas: z.array(z.object({ name: z.string(), ageRange: z.string(), genderSplit: z.string(), details: z.string(), interests: z.array(z.string()) })),
  }),
  keyword: z.object({
    primaryKeywords: z.array(z.string()),
    adGroupSuggestions: z.array(z.string()),
    negativeKeywords: z.array(z.string()),
  }),
  budget: z.object({
    recommendedDailyBudgetCents: z.number().int().nonnegative(),
    testBudgetCents: z.number().int().nonnegative().optional(),
    scaleBudgetCents: z.number().int().nonnegative().optional(),
    platformSplit: z.object({
      meta: z.number().int().min(0).max(100),
      google: z.number().int().min(0).max(100),
      tiktok: z.number().int().min(0).max(100).optional(),
    }).optional(),
    reasoning: z.array(z.string()),
    expectedOutcomes: z.object({
      dailyClicks: z.number().int().optional(),
      dailyImpressions: z.number().int().optional(),
      estimatedCPACents: z.number().int().optional(),
      estimatedROAS: z.number().optional(),
      monthlyConversions: z.number().int().optional(),
    }).optional(),
    riskFactors: z.array(z.string()),
  }),
});

/** First value that has actual content — treats "" and whitespace as absent, which `??` does not. */
function firstNonBlank(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** Composed from the individual agents' fallbacks so a no-model / schema-mismatch run still
 * yields a valid bundle in every sub-part (each sub-agent's fallback is reproduced here). */
function fallback(context: ResearchContext): StrategyAgentOutput {
  // `??` only catches null/undefined, and a crawl that reached the site but found no meta
  // description yields an EMPTY STRING — which sailed through and rendered as literal ad copy
  // reading "Discover ." and ", without the hassle." Blank-safe fallbacks here matter more than
  // usual: whatever this returns can be published as a real ad if the model call failed.
  const name = firstNonBlank(context.company?.name, context.website?.title) ?? "This business";
  const description = firstNonBlank(context.website?.description) ?? "what we offer";
  const segments = context.audience?.segments ?? [];
  const interestTags = context.audience?.interestTags ?? [];
  return {
    campaign: {
      summary: `A balanced acquisition strategy for ${name}, pending fuller research.`,
      recommendedNetworks: ["meta"],
      budgetSplit: { meta: 1 },
      audiences: segments.map((s) => s.name).length ? segments.map((s) => s.name) : [context.audience?.primaryAudience ?? "General audience"],
      creatives: [
        { headline: name, body: `Discover ${description}.`, callToAction: "Learn More" },
        { headline: `Why choose ${name}?`, body: `See why customers pick ${name} for ${description}.`, callToAction: "Get Started" },
        { headline: `${name}: built for you`, body: `${description}, without the hassle.`, callToAction: "Sign Up" },
        { headline: `Try ${name} today`, body: `Join the customers already using ${name}.`, callToAction: "Get Offer" },
      ],
    },
    audience: {
      primaryAudience: context.audience?.primaryAudience ?? "General audience",
      segments,
      painPoints: context.audience?.painPoints ?? [],
      interestTags,
      targetingNotes: "Insufficient research data to give specific targeting guidance.",
      personas: segments.slice(0, 6).map((s) => ({ name: s.name, ageRange: "25-54", genderSplit: "Balanced distribution", details: s.description, interests: interestTags.slice(0, 8) })),
    },
    keyword: {
      primaryKeywords: context.keywords?.primaryKeywords ?? [],
      adGroupSuggestions: [],
      negativeKeywords: [],
    },
    budget: {
      recommendedDailyBudgetCents: 5000,
      reasoning: ["No live market/competitor research available — using a conservative generic starting budget."],
      riskFactors: ["Budget not grounded in real CPC/CPA data"],
    },
  };
}

/**
 * Composite producer super-agent (campaign + audience + keyword + budget). Emits
 * StrategyAgentOutput; AgentCoordinator explodes it into the 4 legacy per-agent result keys.
 */
export class StrategyAgent implements AIAgent<StrategyAgentOutput> {
  readonly name = "strategy-agent";
  readonly promptId = "strategy-agent";

  async execute(context: ResearchContext): Promise<AgentResult<StrategyAgentOutput>> {
    return runAgentStep(this.name, async () => {
      // Union of the fields the four absorbed agents drew from — so the deterministic
      // confidence still reflects how much real input data backed this bundle.
      const fields = ["website", "company", "audience", "market", "competitors", "keywords", "funding"] as const;
      const verifiedFacts = await loadVerifiedFacts(context);
      const generalSearch = context.metadata.generalSearch;
      const { data, promptVersion, usedFallback, modelSource } = await callAgentModel({
        promptId: this.promptId,
        vars: {
          url: context.url ?? "",
          verifiedFacts: verifiedFactsForPrompt(verifiedFacts),
          website: JSON.stringify(context.website ?? {}),
          company: JSON.stringify(context.company ?? {}),
          audience: JSON.stringify(context.audience ?? {}),
          market: JSON.stringify(context.market ?? {}),
          competitors: JSON.stringify(context.competitors ?? {}),
          keywords: JSON.stringify(context.keywords ?? {}),
          funding: JSON.stringify(context.funding ?? {}),
          generalSearch: generalSearch?.narrative ?? "Not available.",
        },
        tool: STRATEGY_AGENT_TOOL,
        schema: strategyAgentSchema,
        // 8192, not 4096: this bundle is the largest structured output in the system — 8-12
        // creatives + a 2-6 persona array (each with 6-15 interests) + segments + keyword lists +
        // budget reasoning, all in ONE forced tool call. At 4096 the tool-call JSON TRUNCATED at
        // max_tokens mid-object, so the model returned an invalid/partial arguments blob → schema
        // validation failed → the deterministic fallback fired, which is what rendered every ad as
        // the "Discover ." / "{name}: built for you" template with an empty description. Doubling
        // the budget lets the full bundle serialize so the REAL LLM creative is used. (Same
        // truncation class as the crawl-fact-extraction 2048→4096 fix.)
        maxTokens: 8192,
        fallback: () => fallback(context),
      });
      return {
        data,
        promptId: this.promptId,
        promptVersion,
        usedFallback,
        modelSource,
        confidence: computeConfidence(context, [...fields], usedFallback),
        evidence: [
          ...collectEvidence(context, [...fields]),
          ...(verifiedFacts.length > 0 ? [{ source: "crawl-facts", detail: `Strategy grounded in ${verifiedFacts.length} verified facts from the site crawl` }] : []),
          ...(generalSearch ? [{ source: "general-search", detail: generalSearch.dataSource }] : []),
        ],
      };
    });
  }
}
