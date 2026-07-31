import type { ResearchContext } from "../research/types/index.js";

/**
 * Serializes a ResearchContext section for inclusion in an agent prompt.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────
 * The composite agents used to interpolate `JSON.stringify(context.<section> ?? {})` straight into
 * their prompts, unbounded. Measured on a real prod run (polluxa.com), that came to ~33,600 tokens
 * of context on EVERY such call, and the `website` section alone was 89% of it:
 *
 *     website          119,634 chars  (~29,900 tok)   <- 89%
 *       ├─ excerpt      73,039 chars
 *       ├─ screenshot   44,513 chars                  <- base64, in a TEXT prompt
 *       └─ everything else ~2,000 chars
 *     audience           4,184 · competitors 2,845 · market 2,097 · company 972 · keywords 374
 *
 * strategy-agent and creative-offer-agent were 68% of a whole generation's token bill (92,740 of
 * 136,011) on the strength of that one section, and the run is input-dominated — 119k input against
 * 17k output — so this is a prompt-size problem, not a reasoning-length one.
 *
 * Two distinct kinds of waste, handled differently:
 *
 *  - `screenshot` is a base64 PNG. Pasted into a text field no model can decode it as an image, so
 *    it is ~11,000 tokens of pure noise per call, billed, every time. It is DROPPED, not truncated —
 *    there is no amount of it worth keeping. Same for the raw `images`/`html` blobs.
 *
 *  - `excerpt` is the full crawled page text, and it IS real signal — but the same crawl was already
 *    distilled into the verified-fact table that these prompts pass separately and label as
 *    authoritative. Beyond the first few thousand characters it is mostly duplicated ground truth
 *    plus long-tail page furniture, so it is CAPPED rather than dropped: the top of a marketing page
 *    carries the value proposition and positioning the agents actually reason from.
 *
 * Output is for a model to read, not to parse, so a cap that leaves the JSON syntactically
 * incomplete is fine — but the truncation is marked, so the model can tell it is seeing a prefix
 * rather than silently treating a cut-off list as the complete set.
 */

/** Fields that are binary/base64 or otherwise unreadable as prompt text — never worth any tokens. */
const NEVER_IN_PROMPT = new Set(["screenshot", "images", "html", "rawHtml", "favicon", "logo"]);

/** Per-section ceiling. Generous: only the pathological sections should ever hit it. */
const DEFAULT_MAX_CHARS = Math.max(500, Number(process.env.AGENT_PROMPT_SECTION_MAX_CHARS ?? 6000));

/** The site excerpt gets its own, larger budget — it is the one long field with genuine signal. */
const EXCERPT_MAX_CHARS = Math.max(500, Number(process.env.AGENT_PROMPT_EXCERPT_MAX_CHARS ?? 8000));

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… [truncated ${text.length - maxChars} more characters]`;
}

/**
 * Strips the never-useful fields and caps the long ones, then serializes.
 * Returns "{}" for a null/undefined section, matching the previous `?? {}` behaviour exactly so a
 * missing section reads the same to the model as it always did.
 */
export function sectionForPrompt(section: unknown, maxChars = DEFAULT_MAX_CHARS): string {
  if (section === null || section === undefined) return "{}";
  if (typeof section !== "object") return truncate(JSON.stringify(section), maxChars);

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
    if (NEVER_IN_PROMPT.has(key)) continue;
    // Cap long strings field-by-field BEFORE serializing. Truncating the finished JSON instead
    // would let one runaway field (excerpt) push every field after it out of the prompt entirely —
    // the agent would lose title, description and crawledPages to make room for page furniture.
    cleaned[key] = typeof value === "string" ? truncate(value, key === "excerpt" ? EXCERPT_MAX_CHARS : maxChars) : value;
  }
  return truncate(JSON.stringify(cleaned), Math.max(maxChars, EXCERPT_MAX_CHARS) + maxChars);
}

/** The website section, which is the one that actually needed this. Kept as a named export so the
 * call sites read as intent ("the website, shaped for a prompt") rather than as a generic cap. */
export function websiteForPrompt(website: ResearchContext["website"]): string {
  return sectionForPrompt(website);
}
