import { test } from "node:test";
import assert from "node:assert";
import {
  groundingScoreAgainstPage,
  verifyFactGrounding,
  GROUNDING_DROP_THRESHOLD,
  type PageText,
} from "../research/crawl/factGroundingVerifier.js";
import type { ExtractedFact } from "../research/crawl/crawlPersistence.js";

const PAGE_TEXT =
  "Acme Analytics helps engineering teams ship faster. Our Pro plan starts at $49/mo and includes " +
  "unlimited dashboards. Trusted by over 2,000 teams including Stripe and Shopify. 14-day free trial, no credit card required.";

test("groundingScoreAgainstPage: verbatim value scores 1.0", () => {
  assert.strictEqual(groundingScoreAgainstPage("14-day free trial", PAGE_TEXT), 1);
});

test("groundingScoreAgainstPage: punctuation/casing differences still score 1.0 after normalization", () => {
  // "$49/mo" vs page "$49/mo" — normalization collapses the punctuation.
  assert.strictEqual(groundingScoreAgainstPage("Pro plan starts at $49/mo", PAGE_TEXT), 1);
});

test("groundingScoreAgainstPage: a value present in no page scores low", () => {
  const score = groundingScoreAgainstPage("Enterprise plan costs $999 per seat annually", PAGE_TEXT);
  assert.ok(score < GROUNDING_DROP_THRESHOLD, `expected < ${GROUNDING_DROP_THRESHOLD}, got ${score}`);
});

test("groundingScoreAgainstPage: numeric guard caps a value whose number is absent from the page", () => {
  // "priced at $79" — the words are generic but 79 is NOT in the page, so the numeric guard caps it.
  const score = groundingScoreAgainstPage("Pro plan priced at $79", PAGE_TEXT);
  assert.ok(score <= 0.49, `numeric guard should cap at 0.49, got ${score}`);
});

test("groundingScoreAgainstPage: correct number present lifts the score above the cap", () => {
  // "$49" IS in the page — no numeric penalty, high token overlap.
  const score = groundingScoreAgainstPage("Pro plan $49", PAGE_TEXT);
  assert.ok(score > 0.49, `expected > 0.49 when the number matches, got ${score}`);
});

test("groundingScoreAgainstPage: empty inputs score 0", () => {
  assert.strictEqual(groundingScoreAgainstPage("", PAGE_TEXT), 0);
  assert.strictEqual(groundingScoreAgainstPage("something", ""), 0);
});

function fact(field: string, value: string, sourceUrl: string, confidence = 0.99): ExtractedFact {
  return { field, value, sourceUrl, confidence };
}

const PAGES: PageText[] = [
  { url: "https://acme.com/", text: PAGE_TEXT },
  { url: "https://acme.com/about", text: "Acme was founded in 2019 in Berlin. We are a remote-first team of 40." },
];

test("verifyFactGrounding: keeps grounded facts and replaces self-reported confidence with the measured score", () => {
  const facts = [fact("pricing.startingPrice", "Pro plan starts at $49/mo", "https://acme.com/", 0.99)];
  const [g] = verifyFactGrounding(facts, PAGES);
  assert.ok(g, "grounded fact should be kept");
  assert.strictEqual(g.groundingScore, 1);
  assert.strictEqual(g.confidence, 1, "confidence is now the MEASURED score, not the 0.99 self-report");
  assert.strictEqual(g.sourceMatched, true);
});

test("verifyFactGrounding: drops a hallucinated fact grounded in no page", () => {
  const facts = [
    fact("pricing.enterprise", "Enterprise tier is $999 per seat billed annually with a dedicated CSM", "https://acme.com/", 0.95),
  ];
  const kept = verifyFactGrounding(facts, PAGES);
  assert.strictEqual(kept.length, 0, "an ungrounded fact must be dropped");
});

test("verifyFactGrounding: re-attributes a fact to the page its value actually appears in", () => {
  // Claims the homepage as source, but "founded in 2019 in Berlin" is on /about.
  const facts = [fact("company.founded", "Founded in 2019 in Berlin", "https://acme.com/", 0.9)];
  const [g] = verifyFactGrounding(facts, PAGES);
  assert.ok(g);
  assert.strictEqual(g.sourceUrl, "https://acme.com/about", "provenance corrected to the real source page");
  assert.strictEqual(g.sourceMatched, false, "flagged as re-attributed (claimed source didn't match)");
});

test("verifyFactGrounding: honest provenance wins ties (keeps claimed source when it matches)", () => {
  const facts = [fact("guarantee", "no credit card required", "https://acme.com/", 0.8)];
  const [g] = verifyFactGrounding(facts, PAGES);
  assert.ok(g);
  assert.strictEqual(g.sourceUrl, "https://acme.com/");
  assert.strictEqual(g.sourceMatched, true);
});

test("verifyFactGrounding: with no usable pages, caps confidence and flags ungrounded rather than trusting self-report", () => {
  const facts = [fact("x", "anything", "https://acme.com/", 0.99)];
  const [g] = verifyFactGrounding(facts, [{ url: "https://acme.com/", text: "" }]);
  assert.ok(g, "facts are kept (nothing to verify against) but not trusted at face value");
  assert.ok(g.confidence <= 0.5, "self-reported 0.99 must not pass through as measured");
  assert.strictEqual(g.sourceMatched, false);
});

test("verifyFactGrounding: empty facts → empty result", () => {
  assert.deepStrictEqual(verifyFactGrounding([], PAGES), []);
});
