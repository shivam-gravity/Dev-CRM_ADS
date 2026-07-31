import { test } from "node:test";
import assert from "node:assert";

import {
  slugify,
  formatCampaignRef,
  formatAdSetRef,
  formatAdRef,
  campaignSlug,
  campaignSeqFromSlug,
  campaignDisplayName,
  adSetDisplayName,
  adDisplayName,
  campaignCreativeKey,
  standaloneObjectKey,
} from "../modules/orchestrator/campaignNaming.js";

test("campaignNaming - refs are zero-padded so names sort in creation order", () => {
  assert.strictEqual(formatCampaignRef(7), "C-0007");
  assert.strictEqual(formatCampaignRef(1234), "C-1234");
  // Sorting is the whole reason for the padding — unpadded, C-10 would sort before C-9.
  const sorted = [formatCampaignRef(10), formatCampaignRef(9), formatCampaignRef(100)].sort();
  assert.deepStrictEqual(sorted, ["C-0009", "C-0010", "C-0100"]);
});

test("campaignNaming - ad set and ad refs are 1-indexed for humans from 0-based array indexes", () => {
  assert.strictEqual(formatAdSetRef(7, 0), "C-0007-A1");
  assert.strictEqual(formatAdSetRef(7, 1), "C-0007-A2");
  assert.strictEqual(formatAdRef(7, 0, 0), "C-0007-A1-01");
  assert.strictEqual(formatAdRef(7, 1, 9), "C-0007-A2-10");
});

// The name that replaces "1c1639dd-1667-4d28-8096-ed3eec7362ed-d7de46a4-b0aa-47fc-8b36-2fd3e3a23d72",
// which was 73 characters of UUID and made sibling ads indistinguishable in Ads Manager.
test("campaignNaming - an ad is named by its ref plus its headline, not by UUIDs", () => {
  const name = adDisplayName(7, 0, 0, "Hiring the top 3% of AI engineers");
  assert.strictEqual(name, "C-0007-A1-01 · Hiring the top 3% of AI engineers");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(name), "must contain no UUID fragment");
  assert.ok(name.length < 60, `should stay short enough to survive table truncation, got ${name.length}`);
});

test("campaignNaming - an ad with no headline still gets a stable, unique-per-slot name", () => {
  assert.strictEqual(adDisplayName(7, 0, 0), "C-0007-A1-01");
  assert.notStrictEqual(adDisplayName(7, 0, 0), adDisplayName(7, 0, 1));
});

// Ads Manager already shows the parent campaign in its own column; repeating it here is what pushed
// the audience name — the only part that differs between ad sets — off the visible width.
test("campaignNaming - an ad set name does NOT repeat the campaign name", () => {
  const name = adSetDisplayName(7, 0, "CTOs & VPs of Engineering at Series A+ AI Startups");
  assert.ok(name.startsWith("C-0007-A1 · "), name);
  assert.ok(!name.includes("Polluxa"), "campaign name must not be duplicated into the ad set name");
});

test("campaignNaming - long names truncate on a word boundary, never mid-word", () => {
  const audience =
    "Engineering leaders (CTOs, VPs of AI/ML, Tech Leads) at high-growth startups, frontier labs, and enterprise GCCs";
  const name = adSetDisplayName(7, 0, audience);
  assert.ok(name.length <= 62, `expected a bounded name, got ${name.length}: ${name}`);
  // A boundary cut never leaves a half-word or a trailing separator.
  assert.ok(!name.endsWith(" "), "must not end in a dangling space");
  const tail = name.split(" · ")[1]!;
  assert.ok(audience.startsWith(tail), "the tail must be a clean prefix of the original, not a mangled slice");
});

test("campaignNaming - an empty audience falls back rather than producing a bare separator", () => {
  assert.strictEqual(adSetDisplayName(7, 0, ""), "C-0007-A1 · General Audience");
});

test("campaignNaming - slugify is URL/filename safe and folds accents to base letters", () => {
  assert.strictEqual(slugify("Polluxa · Traffic · 2026-07-31"), "polluxa-traffic-2026-07-31");
  // NFKD folding keeps the letter; deleting the accent outright would give "caf".
  assert.strictEqual(slugify("Café Münster"), "cafe-munster");
  assert.strictEqual(slugify("  Hello,  World!  "), "hello-world");
  assert.strictEqual(slugify("!!!"), "");
});

test("campaignNaming - a campaign slug leads with the ref and survives a rename", () => {
  const original = campaignSlug(7, "Polluxa · Traffic");
  assert.strictEqual(original, "c-0007-polluxa-traffic");

  // The title is decoration; resolution keys on the ref, so a renamed campaign's old links still work.
  const renamed = campaignSlug(7, "Completely Different Name");
  assert.notStrictEqual(original, renamed);
  assert.strictEqual(campaignSeqFromSlug(original), campaignSeqFromSlug(renamed));
});

test("campaignNaming - slug resolution accepts every form a user might paste", () => {
  assert.strictEqual(campaignSeqFromSlug("c-0007-polluxa-traffic"), 7);
  assert.strictEqual(campaignSeqFromSlug("c-0007"), 7);
  assert.strictEqual(campaignSeqFromSlug("C-0007"), 7, "the ref copied out of Ads Manager is uppercase");
  assert.strictEqual(campaignSeqFromSlug("  c-0007  "), 7);
  assert.strictEqual(campaignSeqFromSlug("c-1234-x"), 1234);
});

test("campaignNaming - a UUID is NOT mistaken for a slug", () => {
  // The middleware must leave real ids alone; treating one as a slug would resolve the wrong row.
  assert.strictEqual(campaignSeqFromSlug("1c1639dd-1667-4d28-8096-ed3eec7362ed"), null);
  assert.strictEqual(campaignSeqFromSlug("not-a-ref"), null);
  assert.strictEqual(campaignSeqFromSlug("c-abc"), null);
  assert.strictEqual(campaignSeqFromSlug("c-0000"), null, "zero is not a valid 1-based sequence");
});

test("campaignNaming - a campaign name that slugifies to nothing still yields a usable slug", () => {
  assert.strictEqual(campaignSlug(7, "!!!"), "c-0007");
  assert.strictEqual(campaignSeqFromSlug(campaignSlug(7, "!!!")), 7);
});

test("campaignNaming - creatives are stored under their campaign, numbered, not in a flat UUID bucket", () => {
  const key = campaignCreativeKey({ workspaceId: "ws-1", seq: 7, index: 0, label: "bold-hero-1x1", extension: "svg" });
  assert.strictEqual(key, "ws-1/campaigns/c-0007/creative-01-bold-hero-1x1.svg");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(key), "no random UUID in the path");
});

test("campaignNaming - creative keys are stable per slot, so a re-run replaces instead of orphaning", () => {
  const first = campaignCreativeKey({ workspaceId: "ws-1", seq: 7, index: 2, label: "hero", extension: "svg" });
  const rerun = campaignCreativeKey({ workspaceId: "ws-1", seq: 7, index: 2, label: "hero", extension: "svg" });
  assert.strictEqual(first, rerun);
  // Different slots must not collide, or one variant would silently overwrite another.
  const other = campaignCreativeKey({ workspaceId: "ws-1", seq: 7, index: 3, label: "hero", extension: "svg" });
  assert.notStrictEqual(first, other);
});

test("campaignNaming - every campaign's creatives share one listable prefix", () => {
  const keys = [0, 1, 2].map((i) =>
    campaignCreativeKey({ workspaceId: "ws-1", seq: 7, index: i, label: "hero", extension: "svg" })
  );
  assert.ok(keys.every((k) => k.startsWith("ws-1/campaigns/c-0007/")), "a campaign's assets must be one prefix");
});

test("campaignNaming - campaign-less creatives go to library/, not a fabricated campaign folder", () => {
  const key = standaloneObjectKey("ws-1", "Studio render", "png", "ab12cd34");
  assert.strictEqual(key, "ws-1/library/studio-render-ab12cd34.png");
  assert.ok(!key.includes("/campaigns/"), "must not imply a campaign that does not exist");
});
