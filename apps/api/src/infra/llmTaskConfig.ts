import type { LLMAssignment, LLMProvider } from "./llmRouter.js";

/**
 * One flat registry, shared by all three LLM call surfaces — the 20 agents, research
 * providers, and the Decision Engine — since a "task" is a task regardless of which
 * subsystem it lives in. The pipeline depends FULLY on Google Gemini: every task resolves to the
 * same Gemini assignment, so this registry now exists only to (a) keep the per-task env-override
 * mechanism (LLM_TASK_<NAME>="gemini:model") for quick model swaps and (b) let a specific task pin
 * a different Gemini model if ever needed — e.g. moving one expensive task onto a pro model, or
 * pinning a task to a specific version after confirming that version has quota on your key.
 *
 * Keys: agent promptIds (e.g. "budget-agent"), research provider names (e.g.
 * "competitor", "reviews"), decision-engine step names (e.g. "decision-summary",
 * "recommendation-ranking", "tradeoff-analysis", "strategy-synthesis",
 * "context-enrichment").
 */
const GEMINI: LLMAssignment = { provider: "gemini", model: process.env.GEMINI_MODEL ?? "gemini-flash-latest" };

const DEFAULT_ASSIGNMENT: LLMAssignment = GEMINI;

const TASK_MODEL_REGISTRY: Record<string, LLMAssignment> = {
  // 3 composite super-agents (the default roster) — each does several of the individual agents'
  // jobs in ONE structured call, cutting the agent layer from 20 calls to 3.
  "strategy-agent": GEMINI,
  "creative-offer-agent": GEMINI,
  "reviewer-agent": GEMINI,

  // 20 marketing agents
  "campaign-agent": GEMINI,
  "audience-agent": GEMINI,
  "budget-agent": GEMINI,
  "competitor-agent": GEMINI,
  "channel-placement-agent": GEMINI,
  "compliance-agent": GEMINI,
  "critic-agent": GEMINI,
  "forecasting-kpi-agent": GEMINI,
  "funnel-retargeting-agent": GEMINI,
  "creative-agent": GEMINI,
  "keyword-agent": GEMINI,
  "localization-agent": GEMINI,
  "market-agent": GEMINI,
  "landing-page-agent": GEMINI,
  "objection-handling-agent": GEMINI,
  "persona-agent": GEMINI,
  "pricing-offer-agent": GEMINI,
  "seo-content-agent": GEMINI,
  "seasonality-timing-agent": GEMINI,
  "product-agent": GEMINI,

  // Decision Engine steps — the USER-VISIBLE strategy output.
  "decision-summary": GEMINI,
  "enrichment-proof-points": GEMINI,
  "enrichment-regional-depth": GEMINI,
  "tradeoff-analysis": GEMINI,
  "recommendation-generation": GEMINI,
  "strategy-synthesis": GEMINI,

  // Research providers
  "app-store": GEMINI,
  audience: GEMINI,
  "ad-library": GEMINI,
  competitor: GEMINI,
  company: GEMINI,
  autocomplete: GEMINI,
  "backlink-authority": GEMINI,
  funding: GEMINI,
  "serp-features": GEMINI,
  "hiring-signals": GEMINI,
  "content-marketing": GEMINI,
  "legal-regulatory": GEMINI,
  "local-presence": GEMINI,
  market: GEMINI,
  partnerships: GEMINI,
  product: GEMINI,
  reddit: GEMINI,
  reviews: GEMINI,
  seo: GEMINI,
  "social-media": GEMINI,
  technology: GEMINI,
  "video-presence": GEMINI,
  website: GEMINI,
  navigation: GEMINI,
  news: GEMINI,
  search: GEMINI,
  "search-ranking": GEMINI,

  // Intelligence Engines + crawl fact extraction
  "audience-intelligence": GEMINI,
  "competitor-intelligence-discovery": GEMINI,
  "competitor-intelligence-enrichment": GEMINI,
  "creative-intelligence": GEMINI,
  "market-intelligence": GEMINI,
  "pricing-intelligence": GEMINI,
  "landing-page-intelligence": GEMINI,
  // The single most valuable call in the run (its facts replace ~17 downstream retrievals) and
  // it's on the CRITICAL PATH — the whole fact-first pipeline is skipped if it doesn't return in
  // time. Pin this one to a higher-throughput model first if rate limits ever starve it.
  "crawl-fact-extraction": GEMINI,
  "ad-creative-analysis": GEMINI,

  // Meta Ads keyword validation & interest mining
  "meta-interest-mining": GEMINI,
  "meta-keyword-validation": GEMINI,
  "budget-market-calibration": GEMINI,
};

const VALID_PROVIDERS = new Set<string>(["gemini"]);

/**
 * Resolution order: per-task env override (quick experiments, no code change) → static
 * registry (checked-in, deliberate) → global default. Env var format:
 * `LLM_TASK_<TASK_NAME>="provider:model"`, e.g. `LLM_TASK_BUDGET_AGENT="gemini:gemini-pro-latest"`.
 * A malformed override (missing `:model`, or an unrecognized provider) is ignored rather
 * than thrown — falls through to the static registry/default instead.
 */
export function resolveTaskModel(taskName: string): LLMAssignment {
  const envKey = `LLM_TASK_${taskName.toUpperCase().replace(/-/g, "_")}`;
  const envOverride = process.env[envKey];
  if (envOverride) {
    const separatorIndex = envOverride.indexOf(":");
    if (separatorIndex > 0) {
      const provider = envOverride.slice(0, separatorIndex);
      const model = envOverride.slice(separatorIndex + 1);
      if (VALID_PROVIDERS.has(provider) && model) {
        return { provider: provider as LLMProvider, model, task: taskName };
      }
    }
  }
  // Spread so the shared GEMINI constant is never mutated with a per-task name.
  return { ...(TASK_MODEL_REGISTRY[taskName] ?? DEFAULT_ASSIGNMENT), task: taskName };
}
