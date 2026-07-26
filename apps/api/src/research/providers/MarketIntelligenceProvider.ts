import type { ResearchProvider } from "../interfaces/ResearchProvider.js";
import type { MarketData, ProviderResult, ResearchProviderInput } from "../types/index.js";
import { runMarketIntelligence } from "../market-intelligence/MarketIntelligenceEngine.js";
import { citationsToEvidence, NO_CITATIONS_DATA_SOURCE, NO_SEARCH_DATA_SOURCE, runProviderStep } from "./support.js";

/**
 * Adapts the Market Intelligence Engine (2 independent searches — growth/demand/
 * seasonality, and regulatory/emerging-competitor — plus a deterministic opportunity
 * score, research/market-intelligence/MarketIntelligenceEngine.ts) into the `MarketData`
 * shape the 9-provider pipeline already expects, replacing the older single-search
 * MarketProvider as the production "market" slot.
 *
 * opportunityScore/regulations/emergingCompetitors are folded into the existing marketSize/
 * trends/competitionLevel strings (same approach CompetitorIntelligenceProvider takes with
 * CompetitorEntry.notes) so nothing that already relies on those fields needs to change.
 * cagr/tam/geographicDemand are genuinely new, optional MarketData fields — additive, since
 * every existing ResearchContext fixture keeps compiling without them.
 */
export class MarketIntelligenceProvider implements ResearchProvider<MarketData> {
  readonly name = "market";
  readonly priority = 40;

  async execute(input: ResearchProviderInput): Promise<ProviderResult<MarketData>> {
    return runProviderStep(this.name, 1, input, async () => {
      const report = await runMarketIntelligence(input);
      const usedFallback = report.citations.length === 0 && report.confidence <= 0.1;

      const regulatoryNote = report.regulations.length > 0 ? ` Regulatory factors: ${report.regulations.join("; ")}.` : "";
      const competitionLevel =
        report.emergingCompetitors.length > 0
          ? `${report.emergingCompetitors.length} emerging competitor(s) gaining traction: ${report.emergingCompetitors.slice(0, 3).join(", ")}. Opportunity score: ${report.opportunityScore}/100.${regulatoryNote}`
          : `No notable emerging competitors identified. Opportunity score: ${report.opportunityScore}/100.${regulatoryNote}`;

      // Base label from citations, then make the market-SIZING provenance explicit: identity/
      // category is fact-grounded, but tam/cagr are LLM estimates unless a real search backed them.
      const baseDataSource = usedFallback
        ? NO_SEARCH_DATA_SOURCE
        : report.citations.length > 0
        ? report.citations.map((c) => c.title).join(" + ")
        : NO_CITATIONS_DATA_SOURCE;
      const dataSource =
        !usedFallback && !report.marketSizingGrounded && (report.tam || report.cagr)
          ? `${baseDataSource} · market sizing (TAM/CAGR) is an AI estimate, not a sourced figure`
          : baseDataSource;

      const data: MarketData = {
        marketSize: report.currentMarket,
        growthRate: report.growth,
        trends: [...report.trends, `Demand: ${report.demand}`, `Seasonality: ${report.seasonality}`],
        competitionLevel,
        cagr: report.cagr,
        tam: report.tam,
        marketSizingGrounded: report.marketSizingGrounded,
        geographicDemand: report.geographicDemand.length > 0 ? report.geographicDemand : undefined,
        dataSource,
      };

      // Pass the engine's own fact-aware confidence through (see ProviderOutcome.confidence): the
      // engine scores fact-grounded output with a high floor even with zero web citations, which
      // the default citation-based scorer would otherwise dock to ~0.35.
      return { status: usedFallback ? "partial" : "success", data, citations: report.citations, evidence: citationsToEvidence(report.citations), confidence: usedFallback ? undefined : report.confidence };
    });
  }
}
