import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Every `/campaigns/:id…` route must carry requireCampaignAccess.
 *
 * It does two jobs, and skipping it loses both:
 *   1. resolveCampaignSlugParam rewrites a slug ("c-0011-polluxa-sales-2026-08-01") to the real
 *      UUID. Every in-app link is a slug, so a route without it 404s on normal navigation —
 *      which is exactly how "Campaign c-0011-polluxa-sales-2026-08-01 not found" reached a user.
 *   2. requireOwned("Campaign", …) is the ownership check. ingest / optimize / auto-optimize
 *      MUTATE a campaign and had none, so any authenticated user could drive them against another
 *      tenant's campaign by id.
 *
 * Asserted against the SOURCE rather than by importing the router: router.ts pulls in Redis, the
 * queues and every service at module load, so importing it here would turn a structural check into
 * an integration test that needs the whole stack up. The registration line is what we care about
 * and it is unambiguous in the text.
 */

const ROUTER_SRC = fileURLToPath(new URL("../gateway/router.ts", import.meta.url));

/** Routes whose ownership check is done INLINE in the handler (resolve job -> getMembership),
 * because they key off a CampaignGenerationJob id rather than a Campaign id. Listed explicitly so
 * adding a new unguarded route can't quietly join them. */
const INLINE_CHECKED = /^\/campaigns\/generate\//;

test("every /campaigns/:id route carries requireCampaignAccess", () => {
  const src = readFileSync(ROUTER_SRC, "utf8");
  const registration = /router\.(get|post|patch|put|delete)\(\s*"(\/campaigns\/[^"]*)"\s*,\s*([^\n]*)/g;

  const unguarded: string[] = [];
  for (const [, method, path, rest] of src.matchAll(registration)) {
    if (!path.includes("/:id")) continue; // collection routes (/campaigns/objectives, /simulate)
    if (INLINE_CHECKED.test(path)) continue;
    if (!rest.includes("requireCampaignAccess")) unguarded.push(`${method.toUpperCase()} ${path}`);
  }

  assert.deepStrictEqual(
    unguarded,
    [],
    `these campaign routes resolve no slug and check no ownership:\n  ${unguarded.join("\n  ")}`
  );
});

test("requireCampaignAccess still bundles slug resolution with the ownership check", () => {
  // The single-line array export is what lets a plain `router.x(path, requireCampaignAccess, …)`
  // registration pick up BOTH. If someone reduces it back to the bare ownership check, every route
  // above keeps its guard but silently loses slug support — and the test above would still pass.
  const src = readFileSync(fileURLToPath(new URL("../gateway/middleware/resourceOwnership.ts", import.meta.url)), "utf8");
  const exportLine = /export const requireCampaignAccess = \[([^\]]*)\]/.exec(src);

  assert.ok(exportLine, "requireCampaignAccess must stay an array of [slug resolver, ownership check]");
  assert.match(exportLine[1], /resolveCampaignSlugParam/, "slug resolution must run first");
  assert.match(exportLine[1], /requireOwned\("Campaign"/, "and the ownership check must follow it");
});
