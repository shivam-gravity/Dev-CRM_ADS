/**
 * Shared request/response shapes the LLM client (geminiClient) builds against — kept in a
 * standalone module so no single client "owns" these types.
 */

export interface JsonSchemaTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface WebSearchCitation {
  url: string;
  title: string;
}

export interface WebSearchOutcome {
  narrative: string;
  citations: WebSearchCitation[];
  searchesUsed: number;
}
