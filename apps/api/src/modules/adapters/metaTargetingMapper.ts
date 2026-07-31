import type { SavedAudience } from "../audience/savedAudienceService.js";
import { listSavedAudiences } from "../audience/savedAudienceService.js";
import { COUNTRY_NAME_TO_CODE } from "./geo/countryCodes.js";
import { logger } from "../logger/logger.js";

const GRAPH_VERSION = "v22.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Meta keys each geo type differently: `countries` are ISO alpha-2 codes, while regions and
 * cities need Meta's own opaque numeric `key` (from the adgeolocation search). All three are
 * optional individually, but Meta rejects a spec with no geo targeting at all.
 */
export interface MetaGeoLocations {
  countries?: string[];
  regions?: { key: string }[];
  cities?: { key: string }[];
}

export interface MetaTargetingSpec {
  age_min: number;
  age_max: number;
  genders?: number[];
  geo_locations: MetaGeoLocations;
  flexible_spec?: { interests: { id: string }[] }[];
  exclusions?: { interests: { id: string }[] };
  // Custom/Lookalike Audiences to target (Meta Graph: targeting.custom_audiences: [{id}]).
  custom_audiences?: { id: string }[];
  // Passed as opaque JSON into AdAdapter's Record<string, unknown> targeting param.
  [key: string]: unknown;
}

const GENDER_CODES: Record<SavedAudience["gender"], number[] | undefined> = {
  all: undefined,
  male: [1],
  female: [2],
};

// Meta's geo_locations.countries expects ISO 3166-1 alpha-2 CODES ("US"), but the UI stores
// human-readable country NAMES ("United States") — sending a name triggers "Invalid country code"
// (#100). Normalize names → codes via the shared full ISO map (geo/countryCodes.ts, ~all countries
// + aliases). Anything that already looks like a 2-letter code passes through uppercased; an
// unknown value is dropped so one bad entry can't fail the whole reach estimate / targeting spec.
function toCountryCodes(locations: string[]): string[] {
  const codes = locations
    .map((loc) => {
      const trimmed = String(loc).trim();
      if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase(); // already an ISO code
      return COUNTRY_NAME_TO_CODE[trimmed.toLowerCase()];
    })
    .filter((c): c is string => Boolean(c));
  return Array.from(new Set(codes));
}

/**
 * Resolve free-text locations into a real Meta `geo_locations` spec via Meta's own
 * adgeolocation search, so COUNTRIES, REGIONS/STATES AND CITIES all work.
 *
 * Why this exists: the previous name→ISO-country map could only ever resolve countries, and it
 * silently defaulted to `["US"]` when nothing matched. Combined with a UI whose placeholder is
 * literally "e.g. New York, London", that meant every city entry was dropped and replaced with
 * UNITED STATES targeting — verified live: ["Bengaluru"] and [] both returned the identical US
 * reach (262.9M) while ["India"] returned 618M. This is not a display bug: the same function
 * feeds resolveAudienceTargetingForWorkspace on the launch path, so an India advertiser typing a
 * city would have published an ad set targeting the US and spent real money there.
 *
 * Meta keys each geo type differently (`countries` are ISO codes; regions/cities need Meta's own
 * numeric `key`), which is why a plain string list cannot express city targeting at all.
 *
 * Best-effort per term: an unresolvable entry is logged and dropped rather than failing the whole
 * spec — but we NEVER substitute a different country for it.
 */
export async function resolveGeoLocations(
  accessToken: string | null,
  locations: string[],
  fallbackCountryCode?: string
): Promise<MetaGeoLocations> {
  const countries = new Set<string>();
  const regions: { key: string }[] = [];
  const cities: { key: string }[] = [];

  // Terms the offline ISO map already handles need no network call; anything else goes to Meta.
  const unresolved: string[] = [];
  for (const raw of locations) {
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    const direct = /^[A-Za-z]{2}$/.test(trimmed) ? trimmed.toUpperCase() : COUNTRY_NAME_TO_CODE[trimmed.toLowerCase()];
    if (direct) countries.add(direct);
    else unresolved.push(trimmed);
  }

  if (accessToken && unresolved.length) {
    for (const term of unresolved) {
      try {
        const url = `${GRAPH_BASE}/search?${new URLSearchParams({
          type: "adgeolocation",
          location_types: JSON.stringify(["country", "region", "city"]),
          q: term,
          limit: "1",
          access_token: accessToken,
        }).toString()}`;
        const res = await fetch(url);
        const json = (await res.json()) as {
          data?: { key: string; type: string; country_code?: string }[];
          error?: { message: string };
        };
        if (!res.ok || json.error) throw new Error(json.error?.message ?? `status ${res.status}`);
        const match = json.data?.[0];
        if (!match) {
          logger.warn(`Meta geo search found no match for "${term}" — dropping from targeting spec`);
          continue;
        }
        if (match.type === "country") countries.add((match.country_code ?? match.key).toUpperCase());
        else if (match.type === "region") regions.push({ key: match.key });
        else cities.push({ key: match.key });
      } catch (err) {
        logger.warn(`Meta geo search failed for "${term}" — dropping from targeting spec`, err);
      }
    }
  } else if (unresolved.length) {
    logger.warn(`No Meta access token for geo search — dropping ${unresolved.length} non-country location(s) from targeting spec`);
  }

  const geo: MetaGeoLocations = {};
  if (countries.size) geo.countries = Array.from(countries);
  if (regions.length) geo.regions = regions;
  if (cities.length) geo.cities = cities;

  // Meta REQUIRES some geo targeting. When nothing resolved, fall back to the AD ACCOUNT's own
  // country rather than a hardcoded "US" — an account billing in INR is overwhelmingly likely to
  // be advertising in India, and guessing the US is both wrong and expensive.
  if (!geo.countries && !geo.regions && !geo.cities) {
    const fallback = fallbackCountryCode?.trim().toUpperCase();
    if (fallback) {
      logger.warn(`No location resolved from ${JSON.stringify(locations)} — falling back to the ad account's country ${fallback}`);
      geo.countries = [fallback];
    } else {
      logger.warn(`No location resolved from ${JSON.stringify(locations)} and no ad-account country known — Meta will reject this spec`);
    }
  }
  return geo;
}

/**
 * The Graph API rejects free-text interests — targeting requires Meta's own numeric
 * interest IDs. Resolves each free-text interest via the interest search endpoint,
 * best-effort: an interest with no match is dropped (logged) rather than failing the
 * whole campaign launch over one unresolvable term.
 */
async function resolveInterests(accessToken: string, freeTextInterests: string[]): Promise<{ id: string; name: string }[]> {
  const resolved: { id: string; name: string }[] = [];
  for (const term of freeTextInterests) {
    try {
      const url = `${GRAPH_BASE}/search?${new URLSearchParams({ type: "adinterest", q: term, access_token: accessToken }).toString()}`;
      const res = await fetch(url);
      const json = (await res.json()) as { data?: { id: string; name: string }[]; error?: { message: string } };
      if (!res.ok || json.error) throw new Error(json.error?.message ?? `status ${res.status}`);
      const match = json.data?.[0];
      if (match) resolved.push(match);
      else logger.warn(`Meta interest search found no match for "${term}" — dropping from targeting spec`);
    } catch (err) {
      logger.warn(`Meta interest search failed for "${term}" — dropping from targeting spec`, err);
    }
  }
  return resolved;
}

/**
 * Maps a SavedAudience (age/gender/location/free-text interests) into a Meta Ad Set
 * `targeting` spec. Pass `accessToken: null` for mock/offline mode (no connected ad
 * account yet) — interest resolution requires a live Graph API call, so it's skipped
 * and the spec falls back to age/gender/geo only, same reduced-fidelity mock pattern
 * every other adapter in this codebase already uses.
 */
export async function buildMetaTargetingSpec(
  accessToken: string | null,
  audience: SavedAudience,
  /** Ad account's country, used ONLY when no location resolves — never to override a real one. */
  fallbackCountryCode?: string
): Promise<MetaTargetingSpec> {
  const [includeInterests, excludeInterests, geoLocations] = accessToken
    ? await Promise.all([
        resolveInterests(accessToken, audience.interests),
        audience.exclusions.length ? resolveInterests(accessToken, audience.exclusions) : Promise.resolve([]),
        resolveGeoLocations(accessToken, audience.locations, fallbackCountryCode),
      ])
    : [[], [], await resolveGeoLocations(null, audience.locations, fallbackCountryCode)];

  const spec: MetaTargetingSpec = {
    age_min: audience.ageMin,
    age_max: audience.ageMax,
    genders: GENDER_CODES[audience.gender],
    geo_locations: geoLocations,
  };
  // flexible_spec/exclusions only accept {"id": "..."} — Meta rejects extra fields like
  // `name` on an interest object, so the search result's name is dropped here.
  if (includeInterests.length) spec.flexible_spec = [{ interests: includeInterests.map((i) => ({ id: i.id })) }];
  if (excludeInterests.length) spec.exclusions = { interests: excludeInterests.map((i) => ({ id: i.id })) };
  // Custom/Lookalike Audience: when this SavedAudience was created on Meta (metaAudienceSync), its
  // real Graph id targets that audience directly. Meta merges custom_audiences with the demographic
  // spec (AND within the audience, OR across multiple), so age/gender/geo still narrow it.
  if (audience.metaCustomAudienceId) spec.custom_audiences = [{ id: audience.metaCustomAudienceId }];
  return spec;
}

export interface ReachEstimate {
  usersLowerBound: number;
  usersUpperBound: number;
  source: "meta" | "heuristic";
}

/** Meta's transient signals: rate limits (4/17/32/613) and any 5xx. */
const TRANSIENT_META_CODES = new Set([4, 17, 32, 613]);

/**
 * One retry with a short backoff for the reach estimate.
 *
 * Deliberately modest: this sits on an interactive path (the builder's audience gauge updates as the
 * user edits targeting), so a long retry chain would just make the UI feel hung. One retry converts
 * the common single-blip failure into a success while keeping the worst case bounded.
 */
async function fetchReachWithRetry(url: string, attempts = 2): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      // A thrown network error is as transient as a 5xx — retry it rather than failing the gauge.
      if (attempt === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    if (res.ok) return res;
    last = res;
    // Peek at the body to classify; clone so the caller can still read it on the final attempt.
    let code: number | undefined;
    try {
      code = ((await res.clone().json()) as { error?: { code?: number } })?.error?.code;
    } catch {
      /* non-JSON error body */
    }
    const transient = res.status >= 500 || (code !== undefined && TRANSIENT_META_CODES.has(code));
    if (!transient || attempt === attempts - 1) return res;
    logger.warn(`fetchMetaReachEstimate: transient Meta failure (status ${res.status}, code ${code ?? "?"}) — retrying once`);
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return last as Response;
}

/** Real reach estimate via Meta's delivery_estimate endpoint, once the workspace has a connected ad account. */
export async function fetchMetaReachEstimate(accessToken: string, adAccountId: string, targeting: MetaTargetingSpec): Promise<ReachEstimate> {
  // Accept either a bare id ("123") or an already-prefixed one ("act_123"): strip any existing
  // "act_" before re-prepending, so a stored "act_773…" doesn't become "act_act_773…" (which Meta
  // 400s, surfaced to the builder's audience gauge as a 502).
  const bare = String(adAccountId).replace(/^act_/, "");
  // Meta requires optimization_goal on delivery_estimate — omitting it 400s with "parameter
  // optimization_goal is required". REACH gives a broad audience-size estimate independent of any
  // specific conversion optimization, which matches what the builder's audience gauge wants.
  const url = `${GRAPH_BASE}/act_${bare}/delivery_estimate?${new URLSearchParams({
    optimization_goal: "REACH",
    targeting_spec: JSON.stringify(targeting),
    access_token: accessToken,
  }).toString()}`;
  // Retry transient failures. This path had NO retry at all while every other Meta call in the
  // codebase has one, so a single rate-limit or 5xx blip surfaced to the builder as a hard 502 and
  // the reach gauge fell back to an error state — observed in production as one 502 between two
  // successful calls seconds apart. Meta's rate-limit codes are 4/17/32/613 (see metaAdapter).
  const res = await fetchReachWithRetry(url);
  const json = (await res.json()) as { data?: { estimate_mau_lower_bound: number; estimate_mau_upper_bound: number }[]; error?: { message: string; code?: number } };
  if (!res.ok || json.error) throw new Error(json.error?.message ?? `Meta delivery_estimate returned ${res.status}`);
  const row = json.data?.[0];
  if (!row) throw new Error("Meta delivery_estimate returned no data");
  return { usersLowerBound: row.estimate_mau_lower_bound, usersUpperBound: row.estimate_mau_upper_bound, source: "meta" };
}

/**
 * Broad fallback used when a strategy audience name has no matching SavedAudience.
 *
 * The country is a PARAMETER, not a constant. This used to be a module constant pinned to
 * `["US"]`, and because strategy-generated audience names essentially never match a SavedAudience,
 * that constant was what almost every real launch used. Verified live: an INR account whose
 * `business_country_code` is "IN" had published ad sets targeting `countries: ["US"]` — rupees
 * aimed at Americans. Defaulting geo is unavoidable (Meta requires it); defaulting it to a country
 * the advertiser has no relationship with is not.
 */
function broadDefaultTargeting(fallbackCountryCode?: string): MetaTargetingSpec {
  const country = fallbackCountryCode?.trim().toUpperCase();
  return {
    age_min: 18,
    age_max: 65,
    geo_locations: country ? { countries: [country] } : {},
  };
}

/**
 * Strategy-generated variants carry a free-text `audienceName` (e.g. "Lookalike of
 * existing customers") that isn't structurally linked to a SavedAudience record — the
 * strategy engine and the audience library evolved separately. Best-effort bridge: if a
 * SavedAudience in this workspace happens to share the name, use its real targeting;
 * otherwise fall back to a broad default rather than failing the whole campaign launch.
 */
export async function resolveAudienceTargetingForWorkspace(
  workspaceId: string,
  audienceName: string | undefined,
  accessToken: string | null,
  /** Ad account's country — the broad fallback targets this instead of a hardcoded "US". */
  fallbackCountryCode?: string
): Promise<MetaTargetingSpec> {
  if (audienceName) {
    const audiences = await listSavedAudiences(workspaceId);
    const match = audiences.find((a) => a.name.toLowerCase() === audienceName.toLowerCase());
    if (match) return buildMetaTargetingSpec(accessToken, match, fallbackCountryCode);
    logger.info(
      `No SavedAudience matches strategy audience "${audienceName}" — using broad default targeting` +
        (fallbackCountryCode ? ` for ${fallbackCountryCode.toUpperCase()}` : " with no country (Meta will reject)")
    );
  }
  return broadDefaultTargeting(fallbackCountryCode);
}

// Bounds the serial Graph interest-search calls per ad set — persona.interests across up to 6
// personas plus audience.interestTags can total ~70 terms; only the first N (after case-insensitive
// string-dedupe) are resolved. 10 mirrors a sensible Meta flexible_spec interest count and keeps
// targeting from over-broadening.
const MAX_AGENT_INTEREST_TERMS = 10;

type InterestResolver = (accessToken: string, terms: string[]) => Promise<{ id: string; name: string }[]>;

function dedupeStringsCapped(values: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Additively merges agent-derived free-text interests (persona.interests + audience.interestTags)
 * into an existing Meta targeting spec's flexible_spec, resolving them to real Meta interest IDs via
 * the same best-effort search resolver buildMetaTargetingSpec already uses. Returns the SAME spec
 * reference unchanged when there are no agent interests, in mock/offline mode (no accessToken —
 * resolution needs a live Graph call), or when nothing resolves. De-dupes by RESOLVED interest id
 * (not free text), so two terms that resolve to the same Meta interest — or an agent term matching an
 * id already present from the SavedAudience — collapse to one. Best-effort: unresolvable terms, a
 * search failure, or a throwing resolver are dropped/logged and never fail the launch. Google-only
 * paths never call this. `resolve` is injectable for deterministic testing (defaults to the real one).
 */
export async function withAgentInterests(
  spec: MetaTargetingSpec,
  agentInterests: string[] | undefined,
  accessToken: string | null,
  resolve: InterestResolver = resolveInterests
): Promise<MetaTargetingSpec> {
  const terms = dedupeStringsCapped(agentInterests ?? [], MAX_AGENT_INTEREST_TERMS);
  if (!terms.length || !accessToken) return spec;

  let resolved: { id: string; name: string }[];
  try {
    resolved = await resolve(accessToken, terms);
  } catch (err) {
    logger.warn("withAgentInterests: interest resolution failed — leaving the targeting spec unchanged", err);
    return spec;
  }
  if (!resolved.length) return spec;

  // Existing (already-resolved) SavedAudience interest ids in the spec, unioned with the agent's
  // resolved ids and de-duped by id — this is where "two different terms -> same id" collapses.
  const existingIds = (spec.flexible_spec ?? []).flatMap((group) => group.interests.map((i) => i.id));
  const seen = new Set<string>();
  const mergedIds: string[] = [];
  for (const id of [...existingIds, ...resolved.map((r) => r.id)]) {
    if (seen.has(id)) continue;
    seen.add(id);
    mergedIds.push(id);
  }
  if (!mergedIds.length) return spec;

  return { ...spec, flexible_spec: [{ interests: mergedIds.map((id) => ({ id })) }] };
}

/** Heuristic fallback when no Meta ad account is connected yet — clearly labeled as an estimate, not a real query. */
export function estimateReachHeuristic(audience: SavedAudience): ReachEstimate {
  const ageSpan = Math.max(1, audience.ageMax - audience.ageMin);
  const specificityPenalty = audience.interests.length * 1.5 + audience.exclusions.length * 1 + (audience.locations.length || 1) * 0.5;
  const base = Math.max(0.5, ageSpan * 0.4 - specificityPenalty);
  return {
    usersLowerBound: Math.round(base * 0.8 * 1_000_000),
    usersUpperBound: Math.round(base * 1.4 * 1_000_000),
    source: "heuristic",
  };
}
