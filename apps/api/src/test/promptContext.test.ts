import { test } from "node:test";
import assert from "node:assert";
import { sectionForPrompt, websiteForPrompt } from "../agents/promptContext.js";

test("a base64 screenshot never reaches the prompt", () => {
  const screenshot = "iVBORw0KGgo".repeat(4000); // ~44k chars, the size measured on a real prod run
  const out = websiteForPrompt({ title: "Acme", excerpt: "Acme sells widgets.", screenshot } as never);

  assert.ok(!out.includes("iVBORw0KGgo"), "the base64 blob must be dropped, not truncated");
  assert.ok(out.includes("Acme sells widgets."), "real content is kept");
  assert.ok(out.length < 1000, `dropped, so the section stays small (got ${out.length} chars)`);
});

test("the site excerpt is capped but its opening — the value proposition — survives", () => {
  const excerpt = `THE VALUE PROPOSITION IS HERE. ${"page furniture. ".repeat(5000)}`;
  const out = websiteForPrompt({ excerpt } as never);

  assert.ok(out.includes("THE VALUE PROPOSITION IS HERE."), "the top of the page is what agents reason from");
  assert.ok(out.includes("truncated"), "and the model is told it is seeing a prefix, not the whole page");
  assert.ok(out.length < excerpt.length / 2, "the long tail is cut");
});

test("one runaway field cannot push the other fields out of the section", () => {
  // Capping the SERIALIZED json instead of each field would drop everything ordered after the
  // excerpt — the agent would lose title/description/crawledPages to make room for page furniture.
  const out = websiteForPrompt({
    excerpt: "x".repeat(500_000),
    title: "Acme Widgets",
    description: "The best widgets",
    crawlJobId: "crawl-123",
  } as never);

  assert.ok(out.includes("Acme Widgets"), "title survives a runaway excerpt");
  assert.ok(out.includes("The best widgets"), "so does description");
  assert.ok(out.includes("crawl-123"), "and so does the crawl reference");
});

test("a missing section still reads as {} exactly as before", () => {
  // The call sites used `JSON.stringify(context.x ?? {})`; prompts and their fixtures depend on
  // that literal, so an absent section must not start rendering as "null" or "".
  assert.strictEqual(sectionForPrompt(null), "{}");
  assert.strictEqual(sectionForPrompt(undefined), "{}");
});

test("a normal-sized section passes through unchanged", () => {
  const company = { name: "Acme", summary: "Sells widgets.", dataSource: "test" };
  assert.strictEqual(sectionForPrompt(company), JSON.stringify(company), "no cap fires below the ceiling");
});
