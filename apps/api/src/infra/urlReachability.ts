import { logger } from "../modules/logger/logger.js";

/**
 * Verify that a candidate ad landing URL actually resolves before an ad is built around it.
 *
 * WHY THIS EXISTS — this was a live money bug. Landing pages were assembled from a hardcoded guess
 * (`LANDING_PAGE_SLUGS = ["", "offer", "checkout", "pricing"]`) appended to the business website, and
 * nothing ever checked whether those paths existed. Verified against the real advertiser:
 *   https://polluxa.com/         200
 *   https://polluxa.com/offer    404   <- ads were being generated pointing here
 *   https://polluxa.com/pricing  200
 *   https://polluxa.com/checkout 404   <- and here
 * So half of every generated campaign pointed at pages that do not exist. Publishing that means
 * paying Meta for clicks that land on a 404, and Meta separately penalises landing-page experience,
 * so it degrades delivery as well as wasting spend.
 *
 * The crawl only ever fetches the homepage and the `navigation` provider returns null, so there is no
 * inventory of real URLs to choose from — verification is the only available fix.
 */

/**
 * Generous by default, and deliberately so. The first version used 6s and reported EVERY url on the
 * real advertiser as unreachable — including the homepage — because from the 2-core prod box that
 * site answers 200 in ~12.4s (a heavy Next.js app; the same slowness makes crawl4ai time out here).
 * A probe timeout shorter than the target site's response time turns this guard into a liar, and the
 * failure mode is silent: everything looks dead, so nothing gets rewritten.
 * Raise via LANDING_URL_PROBE_TIMEOUT_MS on slow hosts. Probes run concurrently, so the cost added to
 * a build/launch is roughly the SLOWEST single probe, not the sum.
 */
const PROBE_TIMEOUT_MS = Math.max(1000, Number(process.env.LANDING_URL_PROBE_TIMEOUT_MS ?? 15000));

/** Probes are best-effort and must never block campaign creation, so failures resolve to `false`. */
async function probe(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // HEAD first (cheap). Some servers reject or mishandle HEAD, so a non-ok HEAD is retried as a
    // GET before concluding the page is missing — otherwise a 405 would look like a dead page.
    const head = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    if (head.ok) return true;
    if (head.status !== 405 && head.status !== 501 && head.status < 500) return false;
  } catch {
    // fall through to GET
  } finally {
    clearTimeout(timer);
  }

  const getController = new AbortController();
  const getTimer = setTimeout(() => getController.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: getController.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(getTimer);
  }
}

export interface LandingUrlResolution {
  /** Usable URL per requested candidate, in the same order. Unreachable ones become `fallbackUrl`. */
  urls: string[];
  /** Candidates that did not resolve, for logging/telemetry. */
  unreachable: string[];
}

/**
 * Resolve candidate landing URLs, substituting `fallbackUrl` for any that do not resolve.
 *
 * Distinct candidates are probed ONCE and concurrently, so a campaign with many variants across a
 * handful of slugs costs a handful of requests. If the FALLBACK itself is unreachable the candidates
 * are returned unchanged — a broken root means we have no better answer, and silently rewriting every
 * ad to a URL we also cannot reach would hide the problem rather than fix it.
 *
 * Caveat worth knowing: a site that answers 200 for unknown paths (soft 404) cannot be detected this
 * way. This catches real HTTP errors, which is what the hardcoded slugs actually produced.
 */
export async function resolveLandingUrls(candidates: string[], fallbackUrl: string): Promise<LandingUrlResolution> {
  const distinct = [...new Set(candidates)];
  const results = new Map<string, boolean>();
  await Promise.all(
    distinct.map(async (url) => {
      results.set(url, await probe(url));
    })
  );

  const unreachable = distinct.filter((url) => !results.get(url));
  if (unreachable.length === 0) return { urls: candidates, unreachable: [] };

  const fallbackOk = results.get(fallbackUrl) ?? (await probe(fallbackUrl));
  if (!fallbackOk) {
    logger.warn(
      `resolveLandingUrls: ${unreachable.length} landing URL(s) unreachable AND the fallback ${fallbackUrl} is too — ` +
        `leaving them as-is rather than rewriting every ad to another dead URL: ${unreachable.join(", ")}`
    );
    return { urls: candidates, unreachable };
  }

  logger.warn(
    `resolveLandingUrls: rewriting ${unreachable.length} unreachable landing URL(s) to ${fallbackUrl} ` +
      `so no ad is published pointing at a dead page: ${unreachable.join(", ")}`
  );
  return { urls: candidates.map((url) => (results.get(url) ? url : fallbackUrl)), unreachable };
}
