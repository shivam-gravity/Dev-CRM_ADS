import { test } from "node:test";
import assert from "node:assert";
import { webAppUrl } from "../gateway/webAppUrl.js";

/**
 * Regression guard for a bug that made EVERY OAuth redirect (all four providers, success and
 * failure) land on the Vite dev server in production: WEB_APP_URL was read with a
 * "http://localhost:5173" default and was never plumbed through docker-compose, so a deployed
 * container could not receive it even if it were set. Users got a browser connection error instead
 * of the app — including for successful connects.
 */

const ENV_KEYS = ["WEB_APP_URL", "PUBLIC_ORIGIN"] as const;

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, run: () => void): void {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
    run();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("webAppUrl - an explicit WEB_APP_URL wins (SPA served from a different origin than the API)", () => {
  withEnv({ WEB_APP_URL: "https://app.example.com", PUBLIC_ORIGIN: "https://api.example.com" }, () => {
    assert.strictEqual(webAppUrl(), "https://app.example.com");
  });
});

// The case that was broken in production: WEB_APP_URL unset, PUBLIC_ORIGIN correctly configured.
test("webAppUrl - falls back to PUBLIC_ORIGIN so a deployment needs no extra configuration", () => {
  withEnv({ PUBLIC_ORIGIN: "http://198.244.141.77:8080" }, () => {
    assert.strictEqual(webAppUrl(), "http://198.244.141.77:8080");
  });
});

test("webAppUrl - the localhost dev default applies ONLY when neither is set", () => {
  withEnv({}, () => {
    assert.strictEqual(webAppUrl(), "http://localhost:5173");
  });
});

// Read per call, not captured at import: a module-level const would freeze whatever the environment
// happened to be at import time, which is both untestable and silently stale.
test("webAppUrl - reads the environment on every call rather than caching at import", () => {
  withEnv({ PUBLIC_ORIGIN: "http://first.example.com" }, () => {
    assert.strictEqual(webAppUrl(), "http://first.example.com");
    process.env.PUBLIC_ORIGIN = "http://second.example.com";
    assert.strictEqual(webAppUrl(), "http://second.example.com", "a cached const would still return the first value");
  });
});
