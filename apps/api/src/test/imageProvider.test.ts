import { test } from "node:test";
import assert from "node:assert";
import { getImageProvider, isImageGenerationEnabled, DefaultImageProvider, MockImageProvider, PlaceholderImageProvider } from "../modules/generation/imageProvider.js";

// This file's assumptions depend on no keyed image API being enabled by ambient env leaked from an
// earlier test file in the same combined `npm test` process.
delete process.env.OPENAI_API_KEY;
delete process.env.STABILITY_API_KEY;
delete process.env.IMAGE_GENERATION_ENABLED;

test("Image Provider - getImageProvider is gated: instant mock by default, real chain via the flag or a key", () => {
  delete process.env.IMAGE_GENERATION_ENABLED;
  assert.ok(getImageProvider() instanceof MockImageProvider, "no flag + no keys -> instant mock (no live pollinations.ai dependency by default)");

  process.env.IMAGE_GENERATION_ENABLED = "true";
  try {
    assert.ok(getImageProvider() instanceof DefaultImageProvider, "IMAGE_GENERATION_ENABLED=true -> real multi-provider chain");
  } finally {
    delete process.env.IMAGE_GENERATION_ENABLED;
  }

  process.env.STABILITY_API_KEY = "st-test";
  try {
    assert.ok(getImageProvider() instanceof DefaultImageProvider, "an image API key -> real chain, no flag needed");
  } finally {
    delete process.env.STABILITY_API_KEY;
  }
});

// GEMINI_API_KEY is the LLM pipeline's credential and EVERY deployment has it set. While Google Imagen
// existed it was keyed off that same variable, so the enable-check needed a special exclusion to stop
// configuring the LLM from silently switching image generation (and its keyless pollinations.ai call)
// on everywhere. Imagen was removed precisely to delete that coupling — this asserts it stayed gone,
// because reintroducing any GEMINI_API_KEY-keyed provider would quietly resurrect the whole problem.
test("Image Provider - GEMINI_API_KEY is an LLM credential ONLY and cannot enable image generation", () => {
  delete process.env.IMAGE_GENERATION_ENABLED;
  delete process.env.OPENAI_API_KEY;
  delete process.env.STABILITY_API_KEY;
  process.env.GEMINI_API_KEY = "g-test";
  try {
    assert.strictEqual(isImageGenerationEnabled(), false, "the LLM credential must not enable image generation");
    assert.ok(getImageProvider() instanceof MockImageProvider);
    assert.deepStrictEqual(
      new DefaultImageProvider().configuredProviders(),
      [],
      "no image provider may be keyed off GEMINI_API_KEY"
    );
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});

test("Image Provider - configuredProviders reflects which API keys are set, in priority order", () => {
  delete process.env.STABILITY_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
  try {
    assert.deepStrictEqual(new DefaultImageProvider().configuredProviders(), ["openai-gpt-image-1"]);
    process.env.STABILITY_API_KEY = "st-test";
    // Priority order, not the order the env vars happened to be set in.
    assert.deepStrictEqual(new DefaultImageProvider().configuredProviders(), ["openai-gpt-image-1", "stability"]);
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.STABILITY_API_KEY;
  }
});

test("Image Provider - PlaceholderImageProvider always returns a visible, prompt-labeled SVG (never empty/1x1)", async () => {
  const image = await new PlaceholderImageProvider().generate("a red running shoe on a track");
  assert.ok(image.buffer.length > 0);
  assert.strictEqual(image.mimeType, "image/svg+xml");
  assert.match(image.buffer.toString("utf8"), /a red running shoe on a track/);
});

test("Image Provider - when enabled with no API keys, the chain falls through to keyless Pollinations for a real image", async () => {
  process.env.IMAGE_GENERATION_ENABLED = "true"; // opt into the chain; keys stay unset to exercise the keyless tier
  const original = global.fetch;
  let calledUrl = "";
  global.fetch = (async (url: unknown) => {
    calledUrl = String(url);
    return new Response(Buffer.from([1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/jpeg" } });
  }) as typeof fetch;
  try {
    const image = await getImageProvider().generate("a red shoe");
    assert.match(calledUrl, /pollinations\.ai/, "with no keys, Pollinations is used");
    assert.strictEqual(image.mimeType, "image/jpeg");
    assert.ok(image.buffer.length > 0);
  } finally {
    global.fetch = original;
    delete process.env.IMAGE_GENERATION_ENABLED;
  }
});

// Guards the removal itself. Google Imagen was the only GEMINI_API_KEY-keyed image provider, and its
// presence forced a shared-credential exception into the enable-check. If it (or anything like it)
// comes back, that exception has to come back too — so the export staying absent is worth asserting
// rather than trusting to review.
test("Image Provider - no GEMINI_API_KEY-keyed image provider is exported", async () => {
  const mod: Record<string, unknown> = await import("../modules/generation/imageProvider.js");
  assert.strictEqual(mod.GoogleImagenImageProvider, undefined, "Imagen was removed to decouple images from the LLM credential");
  assert.strictEqual(mod.SHARED_KEY_PROVIDERS, undefined, "the shared-credential exception is no longer needed and should not return");
});

test("Image Provider - a configured keyed API (OpenAI) takes priority over Pollinations", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  const original = global.fetch;
  let calledUrl = "";
  global.fetch = (async (url: unknown) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from([9, 9, 9]).toString("base64") }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const image = await getImageProvider().generate("a red shoe");
    assert.match(calledUrl, /api\.openai\.com/, "the configured keyed provider is tried before Pollinations");
    assert.strictEqual(image.mimeType, "image/png");
    assert.ok(image.buffer.length > 0);
  } finally {
    global.fetch = original;
    delete process.env.OPENAI_API_KEY;
  }
});

test("Image Provider - when enabled, falls back to the placeholder SVG when every real provider fails (never a missing image)", async () => {
  process.env.IMAGE_GENERATION_ENABLED = "true";
  const original = global.fetch;
  global.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
  try {
    const image = await getImageProvider().generate("a red shoe");
    assert.strictEqual(image.mimeType, "image/svg+xml", "falls back to the always-succeeds placeholder");
    assert.ok(image.buffer.length > 0);
  } finally {
    global.fetch = original;
    delete process.env.IMAGE_GENERATION_ENABLED;
  }
});
