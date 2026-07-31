/**
 * The campaign reference scheme, mirrored on the client.
 *
 * The server is the source of truth (api/src/modules/orchestrator/campaignNaming.ts) — it allocates
 * the number and stores the slug. These helpers only FORMAT what the server already decided, so the
 * two can never drift into disagreeing about what C-0007 means.
 *
 * Every one of these tolerates a campaign with no `seq`: campaigns created before the scheme exists
 * still render and still link, they just fall back to their UUID. Nothing here should ever be the
 * reason an older campaign stops working.
 */

export interface CampaignRefSource {
  id: string;
  seq?: number;
  slug?: string;
}

/** `7` -> `C-0007`. Matches formatCampaignRef on the server, including the padding width. */
export function formatCampaignRef(seq: number): string {
  return `C-${String(seq).padStart(4, "0")}`;
}

/** `C-0007`, or null when the campaign predates the scheme — callers hide the chip rather than fake one. */
export function campaignRef(campaign: CampaignRefSource): string | null {
  return typeof campaign.seq === "number" ? formatCampaignRef(campaign.seq) : null;
}

/** `C-0007-A1` — the ad set (audience group) reference. `index` is 0-based. */
export function adSetRef(campaign: CampaignRefSource, index: number): string | null {
  const base = campaignRef(campaign);
  return base ? `${base}-A${index + 1}` : null;
}

/** `C-0007-A1-02` — the individual ad. Both indexes are 0-based. */
export function adRef(campaign: CampaignRefSource, adSetIndex: number, adIndex: number): string | null {
  const base = adSetRef(campaign, adSetIndex);
  return base ? `${base}-${String(adIndex + 1).padStart(2, "0")}` : null;
}

/**
 * Link target for a campaign: `/campaigns/c-0007-polluxa-traffic`, falling back to the UUID.
 *
 * The API resolves either form (see resolveCampaignSlugParam), so switching a link from id to slug
 * is safe in both directions and old bookmarks keep working.
 */
export function campaignPath(campaign: CampaignRefSource, suffix = ""): string {
  return `/campaigns/${campaign.slug || campaign.id}${suffix}`;
}

/**
 * Link target when only a campaign ID is on hand — resolves the slug, falling back to the ID.
 *
 * Several navigations happen right after a server call that returns an id and nothing else
 * (generation finishing, picking a strategy, opening a draft), which is why those URLs still showed
 * a raw UUID after the rest of the app moved to slugs.
 *
 * Resolving here rather than canonicalising inside the builder is deliberate: the builder's load
 * effect rebuilds every form field from the fetched campaign, so rewriting its URL after mount
 * would re-run that effect and discard whatever the user had typed. Getting the address right
 * BEFORE navigating avoids the redirect entirely.
 *
 * Best-effort — a failed lookup yields the ID form, which the API resolves just as happily.
 */
export async function campaignPathById(
  campaignId: string,
  fetchCampaign: (id: string) => Promise<CampaignRefSource>,
  suffix = ""
): Promise<string> {
  try {
    const campaign = await fetchCampaign(campaignId);
    return campaignPath(campaign, suffix);
  } catch {
    return `/campaigns/${campaignId}${suffix}`;
  }
}

/**
 * Group a campaign's variants into ad sets the way the launcher does — by audienceName, in first-seen
 * order — so the UI hierarchy matches the objects that actually get created on Meta.
 *
 * This grouping is duplicated from launchMetaHierarchy on purpose: showing the user a different
 * shape from what gets published is exactly the confusion this work set out to remove. Keeping the
 * rule in one place on the client (rather than re-deriving it per page) means the Ads Manager, the
 * builder, and the detail view cannot disagree with each other.
 */
export function groupVariantsIntoAdSets<T extends { audienceName?: string }>(variants: T[]): { audienceName: string; variants: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const variant of variants) {
    const key = variant.audienceName || "General Audience";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(variant);
  }
  return [...groups.entries()].map(([audienceName, grouped]) => ({ audienceName, variants: grouped }));
}
