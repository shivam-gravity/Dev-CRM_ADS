import { logger } from "../../modules/logger/logger.js";
import type { ResearchProvider } from "../interfaces/ResearchProvider.js";
import type { AutocompleteData, ProviderResult, ResearchProviderInput } from "../types/index.js";
import { hostnameOf, runProviderStep, sanitizeBusinessName, withTimeout } from "./support.js";

const FETCH_TIMEOUT_MS = 6000;
const DATA_SOURCE = "Google Autocomplete (unofficial public suggest endpoint, best-effort)";

/** No Firecrawl/OpenAI dependency at all — Google's suggest endpoint is a free, unauthenticated
 * JSON API widely relied on by other open-source tools, just not an officially documented one.
 * Labeled honestly as best-effort in dataSource; any failure degrades to an empty list rather
 * than throwing, since Google could change or block this at any time without notice. */
export class AutocompleteProvider implements ResearchProvider<AutocompleteData> {
  readonly name = "autocomplete";
  readonly priority = 214;

  async execute(input: ResearchProviderInput): Promise<ProviderResult<AutocompleteData>> {
    return runProviderStep(this.name, 1, input, async () => {
      for (const query of autocompleteQueries(input)) {
        const suggestions = await fetchSuggestions(query);
        if (suggestions.length > 0) {
          return { status: "success" as const, data: { suggestions, dataSource: `${DATA_SOURCE} — anchor: ${query}` } };
        }
      }
      // Genuinely no suggest coverage: a niche B2B brand nobody searches for by name. Honest partial.
      return { status: "partial" as const, data: { suggestions: [], dataSource: DATA_SOURCE } };
    });
  }
}

/**
 * Anchors to try, most specific first, stopping at the first that yields suggestions.
 *
 * Deliberately NOT buildSearchQuery: that helper wraps the anchor in double quotes, which is right
 * for a search ENGINE (exact-phrase, stops "polluxa" fuzzy-matching "Pollux") but wrong for an
 * autocomplete endpoint, which prefix-matches the raw characters it is given. The quotes were being
 * matched literally, so this provider returned zero suggestions on 8 of 9 prod runs — it was asking
 * Google to complete the string `"Polluxa"`, quote marks included.
 *
 * The ladder then covers the other half of the problem: suggest data only exists for queries people
 * actually type, so a brand with no consumer search volume yields nothing on its name but plenty on
 * its category. Falling back widens the net from "this exact brand" to "what this brand is about",
 * which is the audience-intent signal the provider is mined for anyway.
 */
function autocompleteQueries(input: ResearchProviderInput): string[] {
  const domain = hostnameOf(input.url).replace(/^www\./i, "");
  const cleanName = input.businessName ? sanitizeBusinessName(input.businessName) : "";
  const brand = cleanName || domain.split(".")[0];
  const candidates = [brand, domain, input.industry ? `${input.industry}` : ""];
  return [...new Set(candidates.map((c) => c.trim()).filter((c) => c.length >= 2))];
}

async function fetchSuggestions(query: string): Promise<string[]> {
  try {
    const res = await withTimeout(
      fetch(`https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`),
      FETCH_TIMEOUT_MS,
      "Google Autocomplete"
    );
    if (!res.ok) return [];
    const json = (await res.json()) as [string, string[]];
    return Array.isArray(json?.[1]) ? json[1].slice(0, 10) : [];
  } catch (err) {
    logger.warn(`AutocompleteProvider: suggest request failed for "${query}"`, err);
    return [];
  }
}
