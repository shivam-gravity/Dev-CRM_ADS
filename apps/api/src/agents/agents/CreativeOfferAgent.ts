import { z } from "zod";
import type { AIAgent } from "../interfaces/AIAgent.js";
import { loadVerifiedFacts, verifiedFactsForPrompt } from "../crawlFacts.js";
import { sectionForPrompt, websiteForPrompt } from "../promptContext.js";
import { callAgentModel, collectEvidence, computeConfidence, runAgentStep } from "../support.js";
import type { AgentResult, CreativeOfferAgentOutput, ResearchContext } from "../types/index.js";

/**
 * Composite producer super-agent — does creative-agent + pricing-offer-agent +
 * objection-handling-agent's jobs in ONE structured LLM call. Exploded back into the legacy
 * `results["creative-agent"]`/`["pricing-offer-agent"]`/`["objection-handling-agent"]` keys by
 * AgentCoordinator.deriveLegacyAgentResults.
 */
const CREATIVE_OFFER_AGENT_TOOL = {
  name: "emit_creative_offer_agent_result",
  description: "Return ad creative angles, the offer/pricing angle, and the objection/rebuttal set in one structured result.",
  input_schema: {
    type: "object" as const,
    properties: {
      creative: {
        type: "object",
        properties: {
          headlines: { type: "array", items: { type: "string" }, minItems: 5, maxItems: 5, description: "Exactly 5 DISTINCT ad headlines, each ≤30 characters (Google Responsive Search Ad headline limit)." },
          primaryTexts: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5, description: "Meta primary-text / body copy variants (≤125 chars each)." },
          descriptions: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4, description: "Exactly 4 DISTINCT Google RSA description assets, each ≤90 characters." },
          callToAction: { type: "string" },
          creativeAngles: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5, description: "Short labels for each distinct creative angle, e.g. \"social proof\", \"urgency\"" },
        },
        required: ["headlines", "primaryTexts", "descriptions", "callToAction", "creativeAngles"],
      },
      pricingOffer: {
        type: "object",
        properties: {
          recommendedOfferType: { type: "string", description: "e.g. \"Free trial\", \"Limited-time discount\", \"Money-back guarantee\"" },
          pricingPositioning: { type: "string", description: "1-2 sentences: how to position price relative to competitors (premium, value, undercut)" },
          guaranteeOrRiskReversal: { type: "string", description: "A specific risk-reversal angle or 'None recommended' if not applicable" },
          urgencyAngle: { type: "string", description: "A specific, honest urgency/scarcity angle, or 'None recommended' if forcing urgency would feel dishonest" },
        },
        required: ["recommendedOfferType", "pricingPositioning", "guaranteeOrRiskReversal", "urgencyAngle"],
      },
      objectionHandling: {
        type: "object",
        properties: {
          topObjections: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6, description: "Real objections/hesitations, grounded in audience pain points and real review complaints where available" },
          rebuttalAngles: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6, description: "Concrete ad-copy angles that directly address the objections above (one per objection where possible)" },
          trustSignalsToHighlight: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 5, description: "Specific proof points to feature (reviews, guarantees, certifications) that counter the objections" },
        },
        required: ["topObjections", "rebuttalAngles", "trustSignalsToHighlight"],
      },
    },
    required: ["creative", "pricingOffer", "objectionHandling"],
  },
};

const creativeOfferAgentSchema: z.ZodType<CreativeOfferAgentOutput> = z.object({
  creative: z.object({
    headlines: z.array(z.string()),
    primaryTexts: z.array(z.string()),
    descriptions: z.array(z.string()),
    callToAction: z.string(),
    creativeAngles: z.array(z.string()),
  }),
  pricingOffer: z.object({
    recommendedOfferType: z.string(),
    pricingPositioning: z.string(),
    guaranteeOrRiskReversal: z.string(),
    urgencyAngle: z.string(),
  }),
  objectionHandling: z.object({
    topObjections: z.array(z.string()),
    rebuttalAngles: z.array(z.string()),
    trustSignalsToHighlight: z.array(z.string()),
  }),
});

function fallback(context: ResearchContext): CreativeOfferAgentOutput {
  const name = context.company?.name ?? context.website?.title ?? "This business";
  return {
    creative: {
      headlines: [`${name}: built for you`],
      primaryTexts: [context.website?.description ?? "See what makes us different."],
      descriptions: [context.website?.description ?? "See what makes us different."],
      callToAction: "Learn More",
      creativeAngles: ["general value proposition"],
    },
    pricingOffer: {
      recommendedOfferType: "Free trial",
      pricingPositioning: "Unknown — no live competitor/market research available.",
      guaranteeOrRiskReversal: "None recommended — insufficient research to ground one.",
      urgencyAngle: "None recommended — insufficient research to ground one.",
    },
    objectionHandling: {
      topObjections: ["Not yet researched"],
      rebuttalAngles: ["Not yet researched"],
      trustSignalsToHighlight: [],
    },
  };
}

/**
 * Composite producer super-agent (creative + pricing-offer + objection-handling). Emits
 * CreativeOfferAgentOutput; AgentCoordinator explodes it into the 3 legacy per-agent keys.
 */
export class CreativeOfferAgent implements AIAgent<CreativeOfferAgentOutput> {
  readonly name = "creative-offer-agent";
  readonly promptId = "creative-offer-agent";

  async execute(context: ResearchContext): Promise<AgentResult<CreativeOfferAgentOutput>> {
    return runAgentStep(this.name, async () => {
      const fields = ["website", "audience", "company", "competitors", "market", "reviews"] as const;
      const verifiedFacts = await loadVerifiedFacts(context);
      const { data, promptVersion, usedFallback, modelSource } = await callAgentModel({
        promptId: this.promptId,
        vars: {
          url: context.url ?? "",
          verifiedFacts: verifiedFactsForPrompt(verifiedFacts),
          // See promptContext.ts — this agent and strategy-agent were 68% of a generation's token
          // bill, almost entirely on the unbounded website section they each pasted in whole.
          website: websiteForPrompt(context.website),
          company: sectionForPrompt(context.company),
          audience: sectionForPrompt(context.audience),
          competitors: sectionForPrompt(context.competitors),
          market: sectionForPrompt(context.market),
          reviews: sectionForPrompt(context.reviews),
        },
        tool: CREATIVE_OFFER_AGENT_TOOL,
        schema: creativeOfferAgentSchema,
        // 4096: this emits 5 headlines + up to 5 primary texts + 4 descriptions + creative angles
        // + objections/rebuttals/trust-signals in one forced tool call. 3072 risked truncating the
        // tool-call JSON mid-array (→ schema-fail → template fallback), the same failure mode that
        // gave StrategyAgent its empty "Discover ." creatives. Headroom keeps the real copy.
        maxTokens: 4096,
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
          ...(verifiedFacts.length > 0 ? [{ source: "crawl-facts", detail: `Copy/offer grounded in ${verifiedFacts.length} verified facts from the site crawl` }] : []),
        ],
      };
    });
  }
}
