import { logger } from "../modules/logger/logger.js";
import type { ObjectStorage } from "./objectStorage.js";

/**
 * Stores uploaded IMAGES on Vimeo via the Pictures API, returning Vimeo's CDN URL as the asset's
 * public URL.
 *
 * Vimeo has no general-purpose image hosting; `/me/pictures` is the account's PORTRAIT gallery
 * (avatars). It does accept arbitrary image bytes and hands back a public `link`, which is what makes
 * this possible at all. Three calls are required and the third is the one people miss — a picture that
 * is never activated stays invisible:
 *
 *   1. POST  /me/pictures      -> { uri, link }   reserve a slot, get a one-shot upload target
 *   2. PUT   {link}            -> 204            stream the raw bytes (no auth header on this one)
 *   3. PATCH {uri} active:true -> { link, sizes } publish it and receive the CDN URL
 *
 * TWO LIMITS TO BE AWARE OF, because they affect creative quality rather than causing an error:
 *
 *  - Vimeo RESIZES AND CROPS portraits. What comes back is not byte-identical to what went in, and
 *    the aspect ratio may not survive. For ad creatives that need an exact 1:1 / 4:5 / 9:16 frame,
 *    the returned image can be wrong even though every call succeeded. This is a property of the
 *    endpoint, not something the code can compensate for.
 *  - It is the account portrait gallery, so every uploaded creative becomes an entry there. Vimeo's
 *    terms describe it as a video service; using it as a general image CDN is outside that intent.
 *
 * Given both, this WRAPS a delegate (local object storage) rather than replacing it:
 *  - every image is also written to the delegate, so `get`/`delete` keep working and nothing in the
 *    app depends on Vimeo being reachable to READ an asset back;
 *  - if any Vimeo step fails, the upload still succeeds and returns the delegate's URL, so a Vimeo
 *    outage degrades the CDN choice instead of breaking uploads;
 *  - NON-IMAGE blobs bypass Vimeo entirely. objectStorage also holds crawled HTML and generated
 *    artifacts, and pushing those into a picture gallery would fail or corrupt them.
 */

const VIMEO_API = process.env.VIMEO_API_BASE ?? "https://api.vimeo.com";
// Vimeo requires an explicit API version in Accept; without it you get whatever the default is today.
const VIMEO_ACCEPT = "application/vnd.vimeo.*+json;version=3.4";
const VIMEO_TIMEOUT_MS = Math.max(1000, Number(process.env.VIMEO_TIMEOUT_MS ?? 30_000));

export function isVimeoStorageConfigured(): boolean {
  return Boolean(process.env.VIMEO_ACCESS_TOKEN);
}

interface VimeoPictureCreated {
  uri?: string;
  link?: string;
}

interface VimeoPictureActivated {
  link?: string;
  sizes?: { width?: number; height?: number; link?: string }[];
}

function withTimeout(): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIMEO_TIMEOUT_MS);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export class VimeoPictureStorage implements ObjectStorage {
  constructor(private readonly delegate: ObjectStorage) {}

  /**
   * Runs the three-step flow and returns the largest CDN variant Vimeo offers. `sizes` is preferred
   * over the bare `link` because the top entry is the least-downscaled version available — the bare
   * link tends to be a small square avatar crop, which would be the worst possible choice for an ad
   * creative. Returns null on any failure so the caller can fall back rather than lose the upload.
   */
  private async uploadToVimeo(data: Buffer, contentType: string): Promise<string | null> {
    const token = process.env.VIMEO_ACCESS_TOKEN;
    if (!token) return null;
    const auth = { Authorization: `bearer ${token}`, Accept: VIMEO_ACCEPT };

    // 1. Reserve a picture slot.
    const created = await this.json<VimeoPictureCreated>("POST", `${VIMEO_API}/me/pictures`, { headers: auth });
    if (!created?.uri || !created.link) {
      logger.warn("vimeo: POST /me/pictures returned no upload link — falling back to local storage");
      return null;
    }

    // 2. Stream the bytes to the one-shot upload target. Deliberately NO Authorization header: the
    //    link is pre-signed, and sending credentials to it is both unnecessary and a leak.
    const put = await this.fetchWithTimeout(created.link, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(data),
    });
    if (!put.ok) {
      logger.warn(`vimeo: uploading bytes failed (${put.status}) — falling back to local storage`);
      return null;
    }

    // 3. Activate, or the picture exists but is not publicly visible.
    const activated = await this.json<VimeoPictureActivated>("PATCH", `${VIMEO_API}${created.uri}`, {
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ active: true }),
    });
    if (!activated) return null;

    const largest = (activated.sizes ?? [])
      .filter((s) => s.link)
      .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0];
    const url = largest?.link ?? activated.link ?? null;
    if (!url) {
      logger.warn("vimeo: activated picture carried no link — falling back to local storage");
      return null;
    }
    return url;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const { signal, clear } = withTimeout();
    try {
      return await fetch(url, { ...init, signal });
    } finally {
      clear();
    }
  }

  private async json<T>(method: string, url: string, init: RequestInit): Promise<T | null> {
    const res = await this.fetchWithTimeout(url, { ...init, method });
    if (!res.ok) {
      logger.warn(`vimeo: ${method} ${url} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    return (await res.json()) as T;
  }

  async put(key: string, data: Buffer, contentType?: string): Promise<{ url: string }> {
    // Always write through to the delegate FIRST, so get/delete work and the bytes survive
    // regardless of what Vimeo does with them.
    const local = await this.delegate.put(key, data, contentType);

    // Non-images (crawled HTML, generated artifacts) have no business in a picture gallery.
    if (!contentType?.startsWith("image/") || !isVimeoStorageConfigured()) return local;

    try {
      const vimeoUrl = await this.uploadToVimeo(data, contentType);
      if (vimeoUrl) {
        logger.info(`vimeo: stored ${key} (${data.length} bytes) -> ${vimeoUrl}`);
        return { url: vimeoUrl };
      }
    } catch (err) {
      // An upload must never fail because the CDN did.
      logger.warn(`vimeo: upload threw for ${key} — serving the local URL instead`, err);
    }
    return local;
  }

  /** Reads come from the delegate: the local copy is byte-exact, whereas Vimeo's is resized. */
  get(key: string): Promise<Buffer | null> {
    return this.delegate.get(key);
  }

  /**
   * Deletes the local copy only. The Vimeo picture is intentionally left in place: this class does
   * not persist the returned picture URI anywhere, so there is no reliable way to identify which
   * gallery entry corresponds to a key — and guessing would risk deleting an unrelated picture,
   * including the account's real avatar. Cleaning up the gallery is a manual/administrative task.
   */
  delete(key: string): Promise<void> {
    return this.delegate.delete(key);
  }
}
