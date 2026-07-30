import { test } from "node:test";
import assert from "node:assert";
import { buildMetaTargetingSpec, estimateReachHeuristic, fetchMetaReachEstimate, withAgentInterests } from "../modules/adapters/metaTargetingMapper.js";
import type { SavedAudience } from "../modules/audience/savedAudienceService.js";

const baseAudience: SavedAudience = {
  id: "aud-1",
  workspaceId: "ws-1",
  name: "Test Audience",
  ageMin: 25,
  ageMax: 45,
  gender: "female",
  locations: ["US", "CA"],
  interests: ["Marketing"],
  exclusions: [],
  createdAt: new Date().toISOString(),
};

test("metaTargetingMapper - estimateReachHeuristic returns a labeled, bounded estimate", () => {
  const estimate = estimateReachHeuristic(baseAudience);
  assert.strictEqual(estimate.source, "heuristic");
  assert.ok(estimate.usersLowerBound < estimate.usersUpperBound);
  assert.ok(estimate.usersLowerBound > 0);
});

test("metaTargetingMapper - geo: full country NAMES map to ISO codes (not just the old 12)", async () => {
  // accessToken null skips the interest-search fetch, so this is pure geo mapping.
  const spec = await buildMetaTargetingSpec(null, { ...baseAudience, locations: ["Spain", "Nigeria", "United Arab Emirates", "japan"] });
  assert.deepStrictEqual(spec.geo_locations.countries, ["ES", "NG", "AE", "JP"]);
});

test("metaTargetingMapper - geo: ISO codes pass through; nothing resolving falls back to the AD ACCOUNT's country, never a hardcoded US", async () => {
  const codes = await buildMetaTargetingSpec(null, { ...baseAudience, locations: ["gb", "Atlantis"] });
  assert.deepStrictEqual(codes.geo_locations.countries, ["GB"]); // gb→GB, Atlantis dropped

  // This used to hardcode ["US"]. On a real INR/India account that silently published ad sets
  // targeting the United States, so the fallback now has to be the advertiser's own country.
  const withAccountCountry = await buildMetaTargetingSpec(null, { ...baseAudience, locations: ["Nowhereland"] }, "IN");
  assert.deepStrictEqual(withAccountCountry.geo_locations.countries, ["IN"]);

  // A resolvable location must never be overridden by the fallback.
  const realLocationWins = await buildMetaTargetingSpec(null, { ...baseAudience, locations: ["Spain"] }, "IN");
  assert.deepStrictEqual(realLocationWins.geo_locations.countries, ["ES"]);

  // With no account country known we emit no geo rather than inventing one — Meta rejects the
  // spec, which is strictly better than quietly buying traffic in the wrong country.
  const unknown = await buildMetaTargetingSpec(null, { ...baseAudience, locations: ["Nowhereland"] });
  assert.strictEqual(unknown.geo_locations.countries, undefined);
});

test("metaTargetingMapper - custom_audiences injected when the SavedAudience has a Meta id", async () => {
  const withCa = await buildMetaTargetingSpec(null, { ...baseAudience, metaCustomAudienceId: "act_ca_123" });
  assert.deepStrictEqual(withCa.custom_audiences, [{ id: "act_ca_123" }]);
  const withoutCa = await buildMetaTargetingSpec(null, { ...baseAudience, metaCustomAudienceId: null });
  assert.strictEqual(withoutCa.custom_audiences, undefined);
});

test("metaTargetingMapper - buildMetaTargetingSpec resolves interests and maps demographics", async () => {
  const original = global.fetch;
  global.fetch = (async (url: string) => {
    assert.ok(String(url).includes("/search?"));
    return { ok: true, json: async () => ({ data: [{ id: "6003107902433", name: "Marketing" }] }) } as Response;
  }) as typeof fetch;

  try {
    const spec = await buildMetaTargetingSpec("test-token", baseAudience);
    assert.strictEqual(spec.age_min, 25);
    assert.strictEqual(spec.age_max, 45);
    assert.deepStrictEqual(spec.genders, [2]);
    assert.deepStrictEqual(spec.geo_locations.countries, ["US", "CA"]);
    assert.strictEqual(spec.flexible_spec?.[0]?.interests[0]?.id, "6003107902433");
  } finally {
    global.fetch = original;
  }
});

test("metaTargetingMapper - buildMetaTargetingSpec drops interests with no match instead of failing", async () => {
  const original = global.fetch;
  global.fetch = (async () => ({ ok: true, json: async () => ({ data: [] }) })) as unknown as typeof fetch;

  try {
    const spec = await buildMetaTargetingSpec("test-token", baseAudience);
    assert.strictEqual(spec.flexible_spec, undefined);
  } finally {
    global.fetch = original;
  }
});

test("metaTargetingMapper - fetchMetaReachEstimate parses Meta's delivery_estimate response", async () => {
  const original = global.fetch;
  global.fetch = (async (url: string) => {
    assert.ok(String(url).includes("/act_123/delivery_estimate"));
    return { ok: true, json: async () => ({ data: [{ estimate_mau_lower_bound: 100000, estimate_mau_upper_bound: 200000 }] }) } as Response;
  }) as typeof fetch;

  try {
    const estimate = await fetchMetaReachEstimate("test-token", "123", {
      age_min: 25, age_max: 45, geo_locations: { countries: ["US"] },
    });
    assert.deepStrictEqual(estimate, { usersLowerBound: 100000, usersUpperBound: 200000, source: "meta" });
  } finally {
    global.fetch = original;
  }
});

const specNoInterests = () => ({ age_min: 18, age_max: 65, geo_locations: { countries: ["US"] } });

test("metaTargetingMapper - withAgentInterests dedupes by RESOLVED id (two different terms -> same interest id collapse to one)", async () => {
  // "running" and "jogging" both resolve to 6003; "yoga" is distinct.
  const stub = async (_t: string, terms: string[]) =>
    terms.map((term) => ({ id: term === "running" || term === "jogging" ? "6003" : `id_${term}`, name: term }));
  const merged = await withAgentInterests(specNoInterests(), ["running", "jogging", "yoga"], "tok", stub);
  assert.deepStrictEqual(merged.flexible_spec?.[0].interests.map((i) => i.id), ["6003", "id_yoga"]);
});

test("metaTargetingMapper - withAgentInterests merges agent ids with existing saved-audience ids, deduped by id", async () => {
  const spec = { age_min: 25, age_max: 45, geo_locations: { countries: ["US"] }, flexible_spec: [{ interests: [{ id: "6003" }, { id: "6010" }] }] };
  const stub = async (_t: string, terms: string[]) => terms.map((term) => ({ id: term === "running" ? "6003" : "6099", name: term }));
  const merged = await withAgentInterests(spec, ["running", "hiking"], "tok", stub);
  // existing 6003/6010 kept; agent "running"->6003 deduped against existing; "hiking"->6099 appended.
  assert.deepStrictEqual(merged.flexible_spec?.[0].interests.map((i) => i.id), ["6003", "6010", "6099"]);
});

test("metaTargetingMapper - withAgentInterests caps agent terms at 10 (bounds serial Graph calls) after case-insensitive string-dedupe", async () => {
  let received: string[] = [];
  const stub = async (_t: string, terms: string[]) => { received = terms; return terms.map((term, i) => ({ id: `id_${i}`, name: term })); };
  const many = ["Running", "running", " running "].concat(Array.from({ length: 25 }, (_, i) => `interest ${i}`));
  await withAgentInterests(specNoInterests(), many, "tok", stub);
  assert.strictEqual(received.length, 10, "no more than 10 terms sent to the resolver");
  assert.strictEqual(received[0], "Running", "case-insensitive + trim dedupe, first casing kept");
});

test("metaTargetingMapper - withAgentInterests is a no-op (same reference, resolver not called) with no interests or in mock mode", async () => {
  const spec = specNoInterests();
  const tripwire = async () => { throw new Error("resolver must not be called on a no-op path"); };
  assert.strictEqual(await withAgentInterests(spec, [], "tok", tripwire), spec, "empty -> same reference");
  assert.strictEqual(await withAgentInterests(spec, undefined, "tok", tripwire), spec, "undefined -> same reference");
  assert.strictEqual(await withAgentInterests(spec, ["running"], null, tripwire), spec, "mock mode (null token) -> same reference");
});

test("metaTargetingMapper - withAgentInterests is best-effort: all-dropped or a throwing resolver leaves the spec unchanged (launch survives)", async () => {
  const spec = { age_min: 18, age_max: 65, geo_locations: { countries: ["US"] }, flexible_spec: [{ interests: [{ id: "6003" }] }] };
  const dropAll = async () => [];
  assert.strictEqual(await withAgentInterests(spec, ["nonsense"], "tok", dropAll), spec, "all-dropped -> original spec (existing interest preserved)");
  const thrower = async () => { throw new Error("Graph search 500"); };
  assert.strictEqual(await withAgentInterests(spec, ["running"], "tok", thrower), spec, "throwing resolver -> caught, original spec returned");
});
