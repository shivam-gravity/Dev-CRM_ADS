import { test } from "node:test";
import assert from "node:assert";
import { getImageProvider, isImageGenerationEnabled, DefaultImageProvider, MockImageProvider, PlaceholderImageProvider } from "../modules/generation/imageProvider.js";

// This file's assumptions depend on no keyed image API being enabled by ambient env leaked from an
// earlier test file in the same combined `npm test` process. GEMINI_API_KEY especially: it is the
// LLM pipeline's credential AND google-imagen's, so a real .env key would otherwise flip the
// shared-key gate and appear in configuredProviders().
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.STABILITY_API_KEY;
delete process.env.IMAGE_GENERATION_ENABLED;

test("Image Provider - getImageProvider is gated: instant mock by default, real chain only via the flag or a DEDICATED key", () => {
  delete process.env.IMAGE_GENERATION_ENABLED;
  assert.ok(getImageProvider() instanceof MockImageProvider, "no flag + no keys -> instant mock (no live pollinations.ai dependency by default)");

  // The shared GEMINI_API_KEY (the LLM pipeline's own key) must NOT enable image generation.
  process.env.GEMINI_API_KEY = "g-test";
  try {
    assert.ok(getImageProvider() instanceof MockImageProvider, "GEMINI_API_KEY alone (shared LLM key) must NOT enable image generation");
    // ...but once enabled by the flag, Google Imagen IS still usable as a provider.
    process.env.IMAGE_GENERATION_ENABLED = "true";
    assert.ok(getImageProvider() instanceof DefaultImageProvider, "the flag enables the chain even though only the shared key is present");
    assert.ok(new DefaultImageProvider().configuredProviders().includes("google-imagen"), "Imagen stays usable as a provider once enabled");
    delete process.env.IMAGE_GENERATION_ENABLED;
  } finally {
    delete process.env.GEMINI_API_KEY;
  }

  process.env.IMAGE_GENERATION_ENABLED = "true";
  try {
    assert.ok(getImageProvider() instanceof DefaultImageProvider, "IMAGE_GENERATION_ENABLED=true -> real multi-provider chain");
  } finally {
    delete process.env.IMAGE_GENERATION_ENABLED;
  }

  process.env.STABILITY_API_KEY = "st-test";
  try {
    assert.ok(getImageProvider() instanceof DefaultImageProvider, "a DEDICATED image API key (STABILITY) -> real chain, no flag needed");
  } finally {
    delete process.env.STABILITY_API_KEY;
  }
});

test("Image Provider - configuredProviders reflects which API keys are set, in priority order", () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.STABILITY_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
  try {
    assert.deepStrictEqual(new DefaultImageProvider().configuredProviders(), ["openai-gpt-image-1"]);
    process.env.GEMINI_API_KEY = "g-test";
    process.env.STABILITY_API_KEY = "st-test";
    // google-imagen leads the keyed chain; order is priority order, not insertion order of the env.
    assert.deepStrictEqual(new DefaultImageProvider().configuredProviders(), ["google-imagen", "openai-gpt-image-1", "stability"]);
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.STABILITY_API_KEY;
  }
});

test("Image Provider - the shared Gemini credential does NOT auto-enable image generation", () => {
  delete process.env.IMAGE_GENERATION_ENABLED;
  delete process.env.OPENAI_API_KEY;
  delete process.env.STABILITY_API_KEY;
  // GEMINI_API_KEY is the LLM pipeline's own credential, so EVERY deployment has it set. Setting it
  // here is the point of the test: if the shared-key guard regressed, image generation (and its
  // keyless pollinations.ai tier) would silently switch on everywhere the LLM is configured, and
  // creatives would stop coming from manual upload.
  process.env.GEMINI_API_KEY = "g-test";
  assert.strictEqual(isImageGenerationEnabled(), false, "the shared LLM credential alone must not enable image generation");
  assert.ok(getImageProvider() instanceof MockImageProvider);

  // A dedicated image key DOES enable it, even alongside the shared Gemini key.
  process.env.STABILITY_API_KEY = "st-test";
  try {
    assert.strictEqual(isImageGenerationEnabled(), true, "a dedicated image key enables the chain");
    assert.ok(getImageProvider() instanceof DefaultImageProvider);
  } finally {
    delete process.env.STABILITY_API_KEY;
    // Must also clear the shared key this test set: later tests here assert on the keyless tier and
    // an ambient GEMINI_API_KEY would route them to google-imagen instead of Pollinations.
    delete process.env.GEMINI_API_KEY;
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

// google-imagen now LEADS the keyed chain, so its request shape is worth pinning directly rather
// than only through the chain-priority tests above.
test("Image Provider - GoogleImagenImageProvider posts a :predict request with the mapped aspect ratio", async () => {
  process.env.GEMINI_API_KEY = "g-test";
  const { GoogleImagenImageProvider } = await import("../modules/generation/imageProvider.js");
  const original = global.fetch;
  let calledUrl = "";
  let sentBody: any = null;
  const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"); // PNG magic bytes
  global.fetch = (async (url: unknown, init: any) => {
    calledUrl = String(url);
    sentBody = init?.body ? JSON.parse(init.body) : null;
    return new Response(JSON.stringify({ predictions: [{ bytesBase64Encoded: pngB64, mimeType: "image/png" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const image = await new GoogleImagenImageProvider().generate("a red running shoe on a track", { aspectRatio: "portrait" });
    assert.match(calledUrl, /generativelanguage\.googleapis\.com\/v1beta\/models\/.*:predict/, "hits the Imagen :predict endpoint");
    assert.strictEqual(sentBody?.parameters?.aspectRatio, "3:4", "portrait maps to Imagen's 3:4");
    assert.strictEqual(sentBody?.parameters?.sampleCount, 1);
    assert.strictEqual(image.mimeType, "image/png");
    assert.ok(image.buffer.length > 0);
  } finally {
    global.fetch = original;
    delete process.env.GEMINI_API_KEY;
  }
});

test("Image Provider - an Imagen response carrying no bytes errors so the chain falls through", async () => {
  process.env.GEMINI_API_KEY = "g-test";
  const { GoogleImagenImageProvider } = await import("../modules/generation/imageProvider.js");
  const original = global.fetch;
  global.fetch = (async () =>
    new Response(JSON.stringify({ predictions: [{}] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    await assert.rejects(
      () => new GoogleImagenImageProvider().generate("blocked prompt", { aspectRatio: "square" }),
      /no image bytes/,
      "a filtered/empty result produces no image so the provider errors and the chain moves on",
    );
  } finally {
    global.fetch = original;
    delete process.env.GEMINI_API_KEY;
  }
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
