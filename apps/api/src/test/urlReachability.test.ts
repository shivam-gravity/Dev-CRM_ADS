import { test } from "node:test";
import assert from "node:assert";

// resolveLandingUrls uses global fetch, so the mock must be installed via a stable indirection
// captured before the module resolves (same constraint as the other client tests).
let currentFetchImpl: typeof fetch = (async () => {
  throw new Error("no fetch impl installed for this test");
}) as typeof fetch;
global.fetch = ((...args: Parameters<typeof fetch>) => currentFetchImpl(...args)) as typeof fetch;

const { resolveLandingUrls } = await import("../infra/urlReachability.js");

const ROOT = "https://polluxa.com/";

/** Mirrors the real advertiser measured in production: /offer and /checkout 404, / and /pricing 200. */
function realWorldFetch(seen?: { urls: string[]; methods: string[] }): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    seen?.urls.push(href);
    seen?.methods.push(String(init?.method ?? "GET"));
    const ok = href === ROOT || href === "https://polluxa.com/pricing";
    return new Response(null, { status: ok ? 200 : 404 });
  }) as typeof fetch;
}

test("resolveLandingUrls - rewrites only the UNREACHABLE urls, leaving good ones untouched", async () => {
  currentFetchImpl = realWorldFetch();
  const candidates = [
    "https://polluxa.com/",
    "https://polluxa.com/offer",
    "https://polluxa.com/pricing",
    "https://polluxa.com/checkout",
  ];

  const { urls, unreachable } = await resolveLandingUrls(candidates, ROOT);

  // This is the actual production bug: /offer and /checkout 404, so ads pointed at dead pages.
  assert.deepStrictEqual(urls, [
    "https://polluxa.com/",
    ROOT, // was /offer (404)
    "https://polluxa.com/pricing",
    ROOT, // was /checkout (404)
  ]);
  assert.deepStrictEqual(unreachable.sort(), ["https://polluxa.com/checkout", "https://polluxa.com/offer"]);
});

test("resolveLandingUrls - all reachable returns the candidates unchanged and probes each URL once", async () => {
  const seen = { urls: [] as string[], methods: [] as string[] };
  currentFetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.urls.push(String(url));
    seen.methods.push(String(init?.method ?? "GET"));
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  // Same slug repeated: a campaign has many variants over few slugs, so duplicates must not
  // multiply into duplicate network calls.
  const candidates = [ROOT, ROOT, "https://polluxa.com/pricing", ROOT];
  const { urls, unreachable } = await resolveLandingUrls(candidates, ROOT);

  assert.deepStrictEqual(urls, candidates);
  assert.deepStrictEqual(unreachable, []);
  assert.strictEqual(new Set(seen.urls).size, 2, "must probe each DISTINCT url once");
  assert.ok(seen.methods.every((m) => m === "HEAD"), "a reachable url needs only the cheap HEAD probe");
});

test("resolveLandingUrls - a HEAD-hostile server (405) is retried with GET before being called dead", async () => {
  const seen = { urls: [] as string[], methods: [] as string[] };
  currentFetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = String(init?.method ?? "GET");
    seen.urls.push(String(url));
    seen.methods.push(method);
    // Plenty of real servers reject HEAD; treating that as "page missing" would rewrite valid URLs.
    return new Response(null, { status: method === "HEAD" ? 405 : 200 });
  }) as typeof fetch;

  const { urls, unreachable } = await resolveLandingUrls(["https://polluxa.com/pricing"], ROOT);

  assert.deepStrictEqual(urls, ["https://polluxa.com/pricing"], "must survive a 405 on HEAD");
  assert.deepStrictEqual(unreachable, []);
  assert.deepStrictEqual(seen.methods, ["HEAD", "GET"]);
});

test("resolveLandingUrls - when the FALLBACK is also dead, candidates are left alone", async () => {
  currentFetchImpl = (async () => new Response(null, { status: 500 })) as typeof fetch;
  const candidates = ["https://polluxa.com/offer", "https://polluxa.com/checkout"];

  const { urls, unreachable } = await resolveLandingUrls(candidates, ROOT);

  // Rewriting every ad to a root we also cannot reach would hide the problem, not fix it.
  assert.deepStrictEqual(urls, candidates);
  assert.strictEqual(unreachable.length, 2);
});

test("resolveLandingUrls - a thrown network error counts as unreachable, never as a crash", async () => {
  currentFetchImpl = (async (url: string | URL) => {
    if (String(url) === ROOT) return new Response(null, { status: 200 });
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  const { urls, unreachable } = await resolveLandingUrls(["https://polluxa.com/offer"], ROOT);
  assert.deepStrictEqual(urls, [ROOT]);
  assert.deepStrictEqual(unreachable, ["https://polluxa.com/offer"]);
});
