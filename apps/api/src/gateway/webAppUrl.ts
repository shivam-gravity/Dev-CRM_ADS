/**
 * Where to send the browser back to after an OAuth round-trip.
 *
 * This existed as `process.env.WEB_APP_URL ?? "http://localhost:5173"` duplicated across all four
 * OAuth route files (Meta, Google, Shopify, TikTok) — a Vite dev-server default that is WRONG in
 * every deployed environment. WEB_APP_URL was also never plumbed through docker-compose, so a
 * container could not receive it even if someone set it. The result on the live deployment: EVERY
 * OAuth redirect, success and failure alike, sent the user to a localhost address that does not
 * exist for them, so they saw a browser connection error instead of the app.
 *
 * PUBLIC_ORIGIN is already the deployment's canonical browser-facing origin — it is what builds the
 * OAuth callback URIs in docker-compose — so falling back to it makes the right thing happen with no
 * additional configuration. WEB_APP_URL still wins when set explicitly, which covers the case where
 * the SPA is served from a different origin than the API.
 *
 * Deliberately a FUNCTION, not a module-level const: a const is captured once at import time, which
 * makes the value untestable (and silently stale for anything that adjusts the environment after
 * module load). Reading per call costs nothing here — these are redirect paths, not hot code.
 */
export function webAppUrl(): string {
  return process.env.WEB_APP_URL ?? process.env.PUBLIC_ORIGIN ?? "http://localhost:5173";
}
