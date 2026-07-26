import { llm, runStructured, runWebSearch } from "../../infra/llmClient.js";
import { factGroundingScore, hostnameOf, sanitizeBusinessName, type VerifiedFactInput } from "../providers/support.js";
import { readMemory, writeMemory } from "../memory/MemoryCoordinator.js";
import type { Citation } from "../../types/index.js";

/**
 * Market Intelligence — a richer read on the market a business operates in than the
 * existing MarketProvider (research/providers/MarketProvider.ts, part of the 9-provider
 * pipeline) offers: 2 independent searches (a market-report-style angle covering
 * growth/demand/seasonality/trends, and a regulatory/emerging-competitor angle) combined
 * into one structured profile plus a computed opportunity score. Deliberately NOT wired
 * into MarketProvider/KnowledgeAggregator/ResearchContext — additive, standalone, same
 * posture as Competitor Intelligence relative to CompetitorProvider.
 */

export interface MarketIntelligenceInput {
  url: string;
  businessName?: string;
  industry?: string;
  workspaceId: string;
  businessId?: string;
  /** Verified facts from the business's OWN site (fact-first pipeline). Injected as
   * authoritative grounding so the analysis identifies the RIGHT market/category — without it
   * the generic "market size for X" search drifted to an unrelated market (e.g. "AI service
   * marketplaces / telecom" for what is actually a CRM/sales-software product). */
  verifiedFacts?: { field: string; value: string; sourceUrl?: string; confidence: number }[];
}

export type MarketLevel = "low" | "medium" | "high";

export interface GeographicDemandEntry {
  region: string;
  demandLevel: MarketLevel;
  notes?: string;
}

export interface MarketIntelligenceReport {
  currentMarket: string;
  growth: string;
  demand: string;
  seasonality: string;
  trends: string[];
  emergingCompetitors: string[];
  regulations: string[];
  /** Compound Annual Growth Rate, as stated/estimated in research, e.g. "14.2% CAGR (2024-2029)" */
  cagr?: string;
  /** Total Addressable Market size, e.g. "$42B globally" */
  tam?: string;
  /**
   * Whether the market SIZING (tam/cagr/marketSize) is backed by a real web-search source vs.
   * produced from the model's general knowledge. The fact-first path grounds a business's IDENTITY
   * in its own verified site facts, but those facts never contain TAM/CAGR — so when we skip web
   * search (hasFacts) the sizing numbers are LLM estimates, however precise they look. This flag
   * lets downstream consumers (and the UI) avoid over-trusting an unverified "$42B / 14% CAGR".
   * True only when market sizing came from actual search citations.
   */
  marketSizingGrounded: boolean;
  /** Per-region demand breakdown, or empty if the research didn't surface regional detail. */
  geographicDemand: GeographicDemandEntry[];
  /** Categorical read the model extracts directly from the research narrative — kept
   * separate from opportunityScore below so the score itself never has to be an LLM
   * self-report (see computeOpportunityScore). */
  growthLevel: MarketLevel;
  demandLevel: MarketLevel;
  /** 0-100 — higher means more favorable conditions to enter/expand in this market right
   * now. Deterministically computed from growthLevel/demandLevel/regulations/
   * emergingCompetitors (see computeOpportunityScore) — never an LLM self-report, same
   * principle research/decision/simulation-engine.ts uses for its own scores: asking a
   * model to output a single calibrated 0-100 number produces scores that aren't reliably
   * comparable across runs, whereas the same model reliably categorizes growth/demand as
   * low/medium/high. */
  opportunityScore: number;
  citations: Citation[];
  confidence: number;
  generatedAt: string;
}

const MEMORY_KIND = "market-profile";

const MARKET_TOOL = {
  name: "emit_market_intelligence",
  description: "Return a structured market-intelligence profile.",
  input_schema: {
    type: "object" as const,
    properties: {
      currentMarket: { type: "string", description: "1-2 sentence description of the current state of this market" },
      growth: { type: "string", description: "Growth rate/trajectory, with a number if known" },
      demand: { type: "string" },
      seasonality: { type: "string", description: "Any seasonal demand patterns, or 'None significant' if flat" },
      trends: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
      emergingCompetitors: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 6, description: "Newer/smaller entrants gaining traction, distinct from established players" },
      regulations: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 6, description: "Regulatory factors affecting this market, or empty if none notable" },
      growthLevel: { type: "string", enum: ["low", "medium", "high"], description: "Categorical read of the growth rate/trajectory described in `growth`" },
      demandLevel: { type: "string", enum: ["low", "medium", "high"], description: "Categorical read of current demand strength described in `demand`" },
      cagr: { type: "string", description: "Compound Annual Growth Rate if stated/estimated in the research, e.g. \"14.2% CAGR (2024-2029)\", or omit if not found" },
      tam: { type: "string", description: "Total Addressable Market size if stated/estimated in the research, e.g. \"$42B globally\", or omit if not found" },
      geographicDemand: {
        type: "array",
        minItems: 0,
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            region: { type: "string", description: "e.g. \"North America\", \"APAC\", \"Western Europe\"" },
            demandLevel: { type: "string", enum: ["low", "medium", "high"] },
            notes: { type: "string" },
          },
          required: ["region", "demandLevel"],
        },
        description: "Per-region demand breakdown, or empty if the research didn't surface regional detail",
      },
    },
    required: ["currentMarket", "growth", "demand", "seasonality", "trends", "emergingCompetitors", "regulations", "growthLevel", "demandLevel", "geographicDemand"],
  },
};

type MarketFields = Omit<MarketIntelligenceReport, "citations" | "confidence" | "generatedAt" | "opportunityScore">;

/** Prefix an unverified market-sizing value with "Est." so an LLM general-knowledge figure is never
 * shown as a sourced number. Idempotent (won't double-prefix) and a no-op for empty/undefined. */
export function markEstimate(value?: string): string | undefined {
  if (!value) return value;
  const trimmed = value.trim();
  if (!trimmed || /^est\.?\b/i.test(trimmed)) return trimmed || undefined;
  return `Est. ${trimmed}`;
}

function fallbackFields(subject: string): MarketFields {
  return {
    currentMarket: `Unknown — no live research performed for ${subject}.`,
    growth: "Unknown",
    demand: "Unknown",
    seasonality: "Unknown",
    trends: ["Not yet researched"],
    emergingCompetitors: [],
    regulations: [],
    growthLevel: "low",
    demandLevel: "low",
    marketSizingGrounded: false,
    geographicDemand: [],
  };
}

// factGrounded: the synthesis was anchored in the business's OWN verified facts (fact-first
// pipeline). That's STRONGER grounding than a web citation — the facts came from the actual
// site — so a fact-grounded result earns a high floor even with zero web citations, instead of
// being scored as an ungrounded "AI estimate" (0.35) the way it was before. Without facts, the
// old citation-count behavior is unchanged.
function computeConfidence(usedFallback: boolean, citationCount: number, facts?: VerifiedFactInput[]): number {
  if (usedFallback) return 0.1;
  // Fact-grounded: score by the QUALITY of the business's own verified facts (shared 0.8 floor +
  // a bonus for a rich/high-confidence/multi-source fact base). The fact-first path skips web
  // search, so citationCount is 0 here — previously that pinned the score flat at 0.8; now the
  // fact base itself moves it, the same way for every fact-first engine (see factGroundingScore).
  if (facts?.length) return factGroundingScore(facts);
  return citationCount === 0 ? 0.35 : Math.round(Math.min(0.55 + citationCount * 0.07, 0.9) * 100) / 100;
}

const LEVEL_POINTS: Record<MarketLevel, number> = { low: 20, medium: 60, high: 100 };

/**
 * Deterministic replacement for asking the model to self-report a 0-100 opportunity
 * score directly. Growth and demand (each independently categorized by the model, not
 * scored) each contribute up to 40 points; a flat +20 base reflects "a market exists at
 * all"; regulatory friction and emerging-competitor pressure each shave up to 10 points,
 * capped so neither factor alone can crater the score — only weak growth/demand can do
 * that, mirroring how regulations/competitors are real headwinds but not the whole story.
 */
export function computeOpportunityScore(growthLevel: MarketLevel, demandLevel: MarketLevel, regulationsCount: number, emergingCompetitorsCount: number): number {
  const growthComponent = LEVEL_POINTS[growthLevel] * 0.4;
  const demandComponent = LEVEL_POINTS[demandLevel] * 0.4;
  const regulationPenalty = Math.min(regulationsCount * 3, 10);
  const competitorPenalty = Math.min(emergingCompetitorsCount * 2, 10);
  const score = growthComponent + demandComponent + 20 - regulationPenalty - competitorPenalty;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Runs both market-angle searches, synthesizes one structured profile (with a computed
 * opportunity score), and persists it to Research Memory via the Memory Coordinator
 * (kind: "market-profile", the shortest-lived kind after pricing — market conditions
 * shift faster than competitor positioning does).
 */
export async function runMarketIntelligence(input: MarketIntelligenceInput): Promise<MarketIntelligenceReport> {
  // Strip placeholder tokens before using the name as the market subject — an ungrounded name
  // like "Polluxa Demo Business" otherwise leads the model to invent a market around the word
  // "Demo" (e.g. "demo automation software"). Falls back to the domain when nothing distinctive
  // remains, same anchor rule as buildSearchQuery.
  const cleanName = input.businessName ? sanitizeBusinessName(input.businessName) : "";
  const subject = cleanName || hostnameOf(input.url);
  const industry = input.industry ?? "its category";
  const dedupKey = input.businessId ?? input.url;

  if (!llm) {
    return { ...fallbackFields(subject), opportunityScore: 0, citations: [], confidence: computeConfidence(true, 0), generatedAt: new Date().toISOString() };
  }

  // Fact-first: when the up-front crawl produced verified facts, they pin down the real
  // market/category, so we SKIP the two live web searches (the flaky SearXNG+crawl4ai path whose
  // cold-start latency is the main cause of provider timeouts → 0 scores). The searches only
  // supplemented the facts, which already win on conflict; dropping them when facts exist gives a
  // fast, reliable, fact-grounded market read. With no facts (crawl failed), we still search.
  const hasFacts = !!input.verifiedFacts?.length;
  const emptyResearch = { narrative: "", citations: [] as Citation[] };
  const [marketResearch, regulatoryResearch, priorMatches] = await Promise.all([
    hasFacts ? Promise.resolve(emptyResearch) : runWebSearch(`What is the current market size (TAM), CAGR/growth rate, demand trends, seasonality, and regional/geographic demand breakdown for ${industry} (relevant to a business like "${subject}")? Include any notable trends.`),
    hasFacts ? Promise.resolve(emptyResearch) : runWebSearch(`What emerging/newer competitors are gaining traction in ${industry}, and what regulatory factors affect this market?`),
    readMemory({ kind: MEMORY_KIND, queryText: `${subject} — ${industry}`, workspaceId: input.workspaceId, excludeBusinessId: input.businessId, topK: 2 }),
  ]);

  const memoryContext = priorMatches.length > 0
    ? `\n\nPrior market research on OTHER businesses, retrieved by loose text similarity (Research Memory — this may be about a completely different industry that just happens to use similar vocabulary; only reuse a finding below if it is genuinely about the same product category/market as "${subject}" (${industry}) — otherwise ignore it entirely, do not blend it in):\n${priorMatches.map((m) => `- ${m.content}`).join("\n")}`
    : "";

  // Authoritative grounding: the business's own facts pin down the REAL market/category, so the
  // synthesis sizes the correct market instead of whatever the generic search happened to return.
  const factsContext = input.verifiedFacts?.length
    ? `AUTHORITATIVE — verified facts from the business's own website. First infer the SPECIFIC market/category from these (be precise, e.g. "AI-powered CRM / sales automation software", not a vague "services" market), then size THAT market. Where the web research below is about a different market, IGNORE it:\n${input.verifiedFacts.slice(0, 40).map((f) => `- ${f.field}: ${f.value}`).join("\n")}\n\n`
    : "";

  const structured = await runStructured<MarketFields>({
    maxTokens: 1024,
    tool: MARKET_TOOL,
    messages: [
      {
        role: "user",
        content: `${factsContext}Synthesize a market-intelligence profile for "${subject}" (${industry}) grounded in the authoritative facts above.\n\nMarket/growth/demand research:\n${marketResearch.narrative}\n\nEmerging competitors/regulatory research:\n${regulatoryResearch.narrative}${memoryContext}`,
      },
    ],
  });

  const usedFallback = !structured;
  const fields = structured ?? fallbackFields(subject);

  // Strip the business's OWN name back out of the model's market signals. The subject ("Master's",
  // derived from workspace "Master's Business") is the thing we asked the model to analyze, and
  // ungrounded models routinely echo it back as an "emerging competitor" or as a trend/demand/
  // seasonality token — producing nonsense like "1 emerging competitor gaining traction: Master's"
  // and "trends: Master's". A business is never its own competitor or market trend; drop any signal
  // whose normalized text matches the subject, the raw business name, or the domain host.
  const selfNames = new Set(
    [subject, cleanName, input.businessName, hostnameOf(input.url)]
      .filter(Boolean)
      .map((n) => String(n).toLowerCase().replace(/[^a-z0-9]/g, "")),
  );
  const isSelfReference = (s: string): boolean => {
    const norm = s.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!norm) return false;
    for (const self of selfNames) {
      if (self.length >= 3 && (norm === self || norm.includes(self) || self.includes(norm))) return true;
    }
    return false;
  };
  fields.emergingCompetitors = (fields.emergingCompetitors ?? []).filter((c) => !isSelfReference(c));
  fields.trends = (fields.trends ?? []).filter((t) => !isSelfReference(t));
  if (isSelfReference(fields.demand)) fields.demand = "";
  if (isSelfReference(fields.seasonality)) fields.seasonality = "";

  const citations = usedFallback ? [] : [...marketResearch.citations, ...regulatoryResearch.citations];
  const opportunityScore = usedFallback ? 0 : computeOpportunityScore(fields.growthLevel, fields.demandLevel, fields.regulations.length, fields.emergingCompetitors.length);

  // Market SIZING is grounded only when a real web search backed it. The fact-first path (hasFacts)
  // deliberately skips search, so its tam/cagr/market-size are the model's general-knowledge
  // estimates — correct-looking but unverified. Flag that honestly, and prefix the sizing values
  // with "Est." so no downstream consumer (or the UI) reads an unverified "$42B" as a sourced fact.
  const marketSizingGrounded = !usedFallback && !hasFacts && citations.length > 0;
  if (!marketSizingGrounded) {
    fields.tam = markEstimate(fields.tam);
    fields.cagr = markEstimate(fields.cagr);
  }

  const report: MarketIntelligenceReport = {
    ...fields,
    marketSizingGrounded,
    opportunityScore,
    citations,
    confidence: computeConfidence(usedFallback, citations.length, input.verifiedFacts),
    generatedAt: new Date().toISOString(),
  };

  if (!usedFallback) {
    try {
      await writeMemory({
        workspaceId: input.workspaceId,
        businessId: input.businessId,
        kind: MEMORY_KIND,
        sourceUrl: input.url,
        dedupKey,
        content: `${subject} (${industry}): ${report.currentMarket} Growth: ${report.growth}. Opportunity score: ${report.opportunityScore}.`,
        metadata: report as unknown as Record<string, unknown>,
      });
    } catch {
      // Research Memory is an enhancement, never a reason to fail the report.
    }
  }

  return report;
}
