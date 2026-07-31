import { prisma } from "../../db/prisma.js";
import { withLock } from "../../infra/distributedLock.js";
import { logger } from "../logger/logger.js";

/**
 * One sequential reference, used by every layer that names or stores something.
 *
 * ── The problem this replaces ────────────────────────────────────────────────────────────────
 * Each layer invented its own identifier, and none of them were legible:
 *
 *   campaign name  "Polluxa · Traffic · 2026-07-31"      two campaigns the same day are identical
 *   ad set name    "Polluxa · Traffic · 2026-07-31 — CTOs & VPs of Engineering at Series A+ AI
 *                   Startups"                             82 chars, campaign name repeated verbatim
 *   ad name        "1c1639dd-1667-4d28-8096-ed3eec7362ed-d7de46a4-b0aa-47fc-8b36-2fd3e3a23d72"
 *                                                         73 characters of raw UUID
 *   image key      "<ws>/generated/<randomUUID>.svg"      flat bucket, no link to a campaign or ad
 *   campaign URL   "/campaigns/1c1639dd-1667-4d28-…"      raw UUID
 *
 * A marketer looking at Ads Manager could not tell which ad belonged to which campaign, and an
 * engineer looking at object storage could not tell which file belonged to which ad. Both are the
 * same missing thing: a short, ordered, human-readable name that is stable across systems.
 *
 * ── The scheme ───────────────────────────────────────────────────────────────────────────────
 *   C-0007            campaign      "C-0007 · Polluxa · Traffic"
 *   C-0007-A1         ad set        "C-0007-A1 · CTOs & VPs of Engineering"
 *   C-0007-A1-01      ad            "C-0007-A1-01 · Hiring the top 3% of AI engineers"
 *   c-0007-polluxa-traffic          the campaign's URL slug
 *   <ws>/campaigns/c-0007/a1-01-hiring-the-top-3-ai-engineers.svg    the creative
 *
 * The ref is the first thing in every name, so sorting by name sorts by creation order, and pasting
 * "C-0007" into the Ads Manager search box returns that campaign and everything beneath it. The same
 * string is the storage prefix and the URL prefix, so a support question ("what is C-0007-A1-02?")
 * is answerable without a database lookup.
 */

/** Zero-padding for the campaign counter. Four digits sorts correctly to 9999, then simply grows. */
const CAMPAIGN_SEQ_WIDTH = 4;

/**
 * Budget for the human-readable tail of a name, in characters.
 *
 * Meta accepts long names, but Ads Manager truncates in its table columns, and an ad set called
 * "…Startups" alongside another called "…Startups" is worse than useless. Keeping the tail short
 * enough to survive that truncation is the whole point of renaming.
 */
const NAME_TAIL_BUDGET = 48;

/** Slug tail is a little longer — a URL has more room than a table cell and benefits from context. */
const SLUG_TAIL_BUDGET = 60;

/** Unicode combining diacritical marks (U+0300–U+036F), the residue NFKD leaves behind. */
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

/**
 * How long to wait for the sequence lock before giving up on it.
 *
 * Bounded deliberately: withLock has no timeout of its own, so with Redis unreachable it retried
 * until the caller was killed — seven minutes of a campaign build spent waiting for a naming
 * convenience. Short enough that an outage costs a noticeable pause rather than a hang.
 */
const SEQ_LOCK_TIMEOUT_MS = Math.max(500, Number(process.env.CAMPAIGN_SEQ_LOCK_TIMEOUT_MS ?? 3000));

/** Reject after `ms` so a hung dependency cannot stall the caller indefinitely. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Lowercase, ASCII, hyphen-separated. Safe in a URL, a filename, and an S3 key without escaping.
 *
 * NFKD + stripping non-alphanumerics folds accents to their base letter ("Café" -> "cafe") rather
 * than deleting them ("caf"), so a non-English brand name still produces a readable slug.
 */
export function slugify(value: string, maxLength = SLUG_TAIL_BUDGET): string {
  const base = value
    .normalize("NFKD")
    // Drop the combining marks NFKD just separated out. This step is NOT optional here: without it
    // the next replace turns each mark into a hyphen, so "Münster" slugs to "mu-nster".
    // Built from a string so the range stays ASCII in source — a literal combining mark here is
    // invisible in most editors and trivially mangled by tooling.
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return truncateOnBoundary(base, maxLength, "-");
}

/**
 * Cut to `maxLength` without splitting a word, and without leaving a dangling separator.
 *
 * Naive slicing produces "…top 3% of AI engine" and "c-0007-polluxa-tra", which read like data
 * corruption. Backing up to the last separator costs a few characters and always reads as deliberate.
 * Falls back to a hard cut when the first word alone is longer than the budget.
 */
function truncateOnBoundary(value: string, maxLength: number, separator: string): string {
  if (value.length <= maxLength) return value;
  const cut = value.slice(0, maxLength);
  const lastSeparator = cut.lastIndexOf(separator);
  // Only honour the boundary if it leaves a reasonable amount of text; otherwise a long first word
  // would collapse the whole tail to almost nothing.
  const trimmed = lastSeparator > maxLength * 0.5 ? cut.slice(0, lastSeparator) : cut;
  return trimmed.replace(new RegExp(`${separator}+$`), "");
}

/** Collapse whitespace and strip characters that make a name hard to scan in a table. */
function cleanTitle(value: string, maxLength = NAME_TAIL_BUDGET): string {
  const collapsed = value.replace(/\s+/g, " ").trim().replace(/[·|]/g, "-");
  return truncateOnBoundary(collapsed, maxLength, " ");
}

/** `7` -> `C-0007`. The canonical short name for a campaign, everywhere. */
export function formatCampaignRef(seq: number): string {
  return `C-${String(seq).padStart(CAMPAIGN_SEQ_WIDTH, "0")}`;
}

/** `(7, 0)` -> `C-0007-A1`. Ad sets are 1-indexed for humans; the argument is a 0-based array index. */
export function formatAdSetRef(seq: number, adSetIndex: number): string {
  return `${formatCampaignRef(seq)}-A${adSetIndex + 1}`;
}

/** `(7, 0, 1)` -> `C-0007-A1-02`. Two digits: an ad set with 100+ ads is not a naming problem. */
export function formatAdRef(seq: number, adSetIndex: number, adIndex: number): string {
  return `${formatAdSetRef(seq, adSetIndex)}-${String(adIndex + 1).padStart(2, "0")}`;
}

/**
 * The campaign's URL slug: `c-0007-polluxa-traffic`.
 *
 * The ref comes FIRST and is what resolution actually keys on (see campaignSeqFromSlug), so the
 * title is decoration. Renaming a campaign changes the pretty part of the URL while every link ever
 * shared keeps working — the alternative, a title-only slug, breaks bookmarks on every rename.
 */
export function campaignSlug(seq: number, name: string): string {
  const tail = slugify(name);
  const ref = formatCampaignRef(seq).toLowerCase();
  return tail ? `${ref}-${tail}` : ref;
}

/**
 * Recover the campaign sequence from a slug, or null if it carries none.
 *
 * Deliberately lenient: anything starting `c-<digits>` resolves, so `c-0007`, `c-0007-anything`, and
 * a slug from before a rename all reach the same campaign. Also accepts a bare `C-0007` so the ref a
 * user copies out of Ads Manager can be pasted straight into the URL bar.
 */
export function campaignSeqFromSlug(slug: string): number | null {
  const match = /^c-0*(\d+)(?:-|$)/i.exec(slug.trim());
  if (!match) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

/** `"C-0007 · Polluxa · Traffic"` — what appears in Ads Manager's campaign column. */
export function campaignDisplayName(seq: number, campaignName: string): string {
  return `${formatCampaignRef(seq)} · ${cleanTitle(campaignName)}`;
}

/**
 * `"C-0007-A1 · CTOs & VPs of Engineering"`.
 *
 * The campaign name is deliberately NOT repeated. Ads Manager already shows the parent campaign in
 * its own column, so prefixing it burned the entire visible width on a string the user could
 * already see — which is why audience names were being cut off exactly where they differ.
 */
export function adSetDisplayName(seq: number, adSetIndex: number, audienceName: string): string {
  const tail = cleanTitle(audienceName || "General Audience");
  return `${formatAdSetRef(seq, adSetIndex)} · ${tail}`;
}

/**
 * `"C-0007-A1-01 · Hiring the top 3% of AI engineers"`.
 *
 * Replaces `${campaign.id}-${variant.id}` — 73 characters of UUID that told a marketer nothing and
 * made two ads in the same ad set indistinguishable without opening each one. The headline is the
 * one thing that actually differs between sibling ads, so it is the tail.
 */
export function adDisplayName(seq: number, adSetIndex: number, adIndex: number, headline?: string): string {
  const ref = formatAdRef(seq, adSetIndex, adIndex);
  const tail = cleanTitle(headline ?? "");
  return tail ? `${ref} · ${tail}` : ref;
}

/**
 * Object-storage key for a campaign's creative: `<ws>/campaigns/c-0007/creative-01-bold-hero-1x1.svg`.
 *
 * Replaces `<ws>/generated/<randomUUID>.<ext>`, where every campaign's images landed in one flat
 * directory under names that revealed nothing — you could not tell which file belonged to which
 * campaign without opening it, and the assets for one campaign could not be listed, copied, or
 * removed as a unit.
 *
 * Numbered at the CAMPAIGN level rather than per ad, because that is what the generator actually
 * knows: images are produced as a pool of variants and only round-robin assigned to ads afterwards
 * (see runVectorAdGenerationJob). Naming a file for an ad it is not yet attached to would encode a
 * relationship that does not exist yet and goes stale the moment assignment changes.
 *
 * `index` is the generator's own variant number, so a re-run overwrites its previous output for that
 * slot instead of accumulating orphans — the flat-UUID scheme could never do this.
 */
export function campaignCreativeKey(input: {
  workspaceId: string;
  seq: number;
  index: number;
  label?: string;
  extension: string;
}): string {
  const { workspaceId, seq, index, label, extension } = input;
  const campaignDir = formatCampaignRef(seq).toLowerCase();
  const numbered = `creative-${String(index + 1).padStart(2, "0")}`;
  const file = label ? slugify(`${numbered}-${label}`, 56) : numbered;
  return `${workspaceId}/campaigns/${campaignDir}/${file}.${extension}`;
}

/**
 * Storage key for a creative that has no campaign yet (Creative Studio, ad-hoc generation).
 *
 * Kept separate and explicitly dated rather than forced into the campaign scheme: pretending an
 * orphan asset belongs to "C-0000" would be a lie that later reads as a real campaign.
 */
export function standaloneObjectKey(workspaceId: string, label: string, extension: string, uniqueSuffix: string): string {
  const name = slugify(label || "creative", 48);
  return `${workspaceId}/library/${name}-${slugify(uniqueSuffix, 12)}.${extension}`;
}

/**
 * Next campaign number for a workspace.
 *
 * Per-WORKSPACE, not global: a tenant seeing "C-0431" for their first campaign leaks how much other
 * traffic the platform carries, and gaps in their own numbering look like deleted work. Every
 * workspace starts at C-0001.
 *
 * Allocated under a lock because the counter is derived (max + 1) rather than a database sequence.
 * Two campaigns generated concurrently for one workspace would otherwise both read the same max and
 * both claim it — the exact duplicate-reference bug this scheme exists to prevent. The lock is
 * per-workspace so unrelated tenants never wait on each other.
 *
 * Never throws: a workspace with no campaigns yet, or a lock/query failure, falls back to a
 * timestamp-derived number. A slightly odd reference is recoverable; failing generation is not.
 */
export async function allocateCampaignSeq(workspaceId: string | null | undefined): Promise<number> {
  // A campaign whose business has no workspace still needs a reference. Counting the unowned rows
  // together keeps them ordered relative to each other, which is all the scheme promises here.
  const scope = workspaceId ?? null;
  try {
    return await withTimeout(
      withLock(`campaign-seq:${scope ?? "unassigned"}`, 15_000, () => nextSeqForScope(scope)),
      SEQ_LOCK_TIMEOUT_MS,
      "campaign sequence lock"
    );
  } catch (lockErr) {
    // ── Degrade, never block. ──
    // The lock lives in Redis, and a naming convenience must not make Redis a hard dependency of
    // creating a campaign: measured with Redis down, an unbounded withLock stalled the whole build
    // for seven minutes before anything gave up. Losing the lock only risks two concurrent builds in
    // the same workspace claiming one number — a cosmetic duplicate, since the UUID is still the key.
    logger.warn(
      `allocateCampaignSeq: sequence lock unavailable for workspace ${scope ?? "(unassigned)"} — allocating ` +
        "without it. Concurrent builds could share a reference; the campaign id remains unique.",
      lockErr
    );
    try {
      return await nextSeqForScope(scope);
    } catch (dbErr) {
      // The database is unreachable, so this campaign is not going to save either — return something
      // ordered and move on rather than adding a second failure on top of the real one.
      const fallback = Math.floor(Date.now() / 1000) % 100_000;
      logger.warn(
        `allocateCampaignSeq: could not read existing references either — falling back to ` +
          `${formatCampaignRef(fallback)}. Ordering may be off; nothing else is affected.`,
        dbErr
      );
      return fallback;
    }
  }
}

/** max(seq) + 1 across the scope's campaigns. Separated so it can run with or without the lock. */
async function nextSeqForScope(scope: string | null): Promise<number> {
  const rows = await prisma.campaign.findMany({ where: { workspaceId: scope }, select: { data: true } });
  let max = 0;
  for (const row of rows) {
    const seq = (row.data as { seq?: unknown } | null)?.seq;
    if (typeof seq === "number" && Number.isSafeInteger(seq) && seq > max) max = seq;
  }
  return max + 1;
}
