import { getBusiness } from "../business/businessService.js";
import { listCampaignsForBusiness } from "../orchestrator/campaignOrchestrator.js";
import { getAnalyticsSummary } from "../analytics/analyticsService.js";
import { logger } from "../logger/logger.js";
import * as gemini from "../../infra/geminiClient.js";
import type { StrategistChatMessage } from "./strategistService.js";

async function buildSystemPrompt(businessId: string): Promise<string> {
  const business = await getBusiness(businessId);
  const campaigns = await listCampaignsForBusiness(businessId);
  const summary = await getAnalyticsSummary(businessId, "all");

  const context = {
    business: business
      ? { name: business.name, industry: business.industry, monthlyBudgetCents: business.monthlyBudgetCents, goals: business.goals }
      : null,
    campaigns: campaigns.map((c) => ({ name: c.name, status: c.status, networks: c.networks, dailyBudgetCents: c.dailyBudgetCents })),
    performance: summary,
  };

  return `You are the CRM Ads Strategist, an expert media-buying assistant embedded in the "Media Plan" section of a paid-ads platform. You help the user generate, revise, and evaluate their media plan, and can set long-term brand preferences on request.

Speak concisely and concretely, referencing real numbers from the account data below when relevant. If the account has no active campaigns yet, say so and guide the user toward launching their first campaign rather than inventing data.

Current account context:
${JSON.stringify(context, null, 2)}`;
}

/**
 * Delivers the strategist response via the same chunk callback the SSE endpoint expects.
 * Backed by Claude via Amazon Bedrock. Bedrock's ConverseStream uses AWS binary event-stream
 * framing (impractical over the plain-fetch client this codebase uses), so this issues a single
 * non-streaming Bedrock call and emits the full answer as one chunk — the callback contract
 * (onChunk(text,false) … onChunk("",true,fullText)) is preserved, so the endpoint needs no change.
 * Falls back to a static message if Bedrock isn't configured.
 */
export async function chatWithStrategistStream(
  businessId: string,
  messages: StrategistChatMessage[],
  onChunk: (chunk: string, done: boolean, fullText?: string) => void,
): Promise<void> {
  const systemPrompt = await buildSystemPrompt(businessId);

  if (!gemini.isGeminiConfigured()) {
    const business = await getBusiness(businessId);
    const campaigns = await listCampaignsForBusiness(businessId);
    const fallback = campaigns.length === 0
      ? `I don't have any live campaign data for ${business?.name ?? "this business"} yet. Once you launch your first campaign, I'll be able to analyze performance and help you build out a media plan.`
      : `I can see ${campaigns.length} campaign(s) on ${business?.name ?? "this account"}. Ask me about performance, budget shifts, or what to test next.`;
    onChunk(fallback, true, fallback);
    return;
  }

  try {
    const fullText = await gemini.runText({
      maxTokens: 1024,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const answer = fullText ?? "I'm having trouble connecting right now. Please try again in a moment.";
    if (fullText) onChunk(fullText, false);
    onChunk("", true, answer);
  } catch (err) {
    logger.error("Strategist stream failed", err);
    onChunk("I'm having trouble connecting right now. Please try again in a moment.", true);
  }
}
