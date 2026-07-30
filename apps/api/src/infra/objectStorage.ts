import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VimeoPictureStorage, isVimeoStorageConfigured } from "./vimeoPictureStorage.js";

/**
 * Provider-agnostic blob storage. The interface is deliberately narrow (put/get/delete
 * keyed by string) so a future S3/GCS/R2-backed implementation (roadmap Phase 4's
 * Object Store) is a drop-in replacement for LocalFileObjectStorage — no call site
 * needs to know which one is behind `objectStorage`.
 */
export interface ObjectStorage {
  put(key: string, data: Buffer, contentType?: string): Promise<{ url: string }>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Writes to apps/api/data/objects/ and serves files back out via the /objects
 * static route mounted in src/index.ts. Good enough for local dev; a real
 * deployment swaps this for an S3/GCS/R2 client behind the same interface.
 */
export class LocalFileObjectStorage implements ObjectStorage {
  constructor(
    private readonly rootDir = path.resolve(__dirname, "../../data/objects"),
    private readonly publicUrlPrefix = "/objects"
  ) {}

  private resolvePath(key: string): string {
    // Reject path traversal — keys are used to build a filesystem path.
    const normalized = path.normalize(key).replace(/^(\.\.[/\\])+/, "");
    return path.join(this.rootDir, normalized);
  }

  async put(key: string, data: Buffer): Promise<{ url: string }> {
    const filePath = this.resolvePath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
    return { url: `${this.publicUrlPrefix}/${key}` };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolvePath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolvePath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  get diskRoot(): string {
    return this.rootDir;
  }
}

/**
 * Local disk is always the substrate. When VIMEO_ACCESS_TOKEN is set, uploaded IMAGES additionally go
 * to Vimeo's Pictures API and the asset's public URL becomes Vimeo's CDN link — see
 * vimeoPictureStorage.ts, including the resize/crop caveat that matters for ad creatives.
 *
 * The wrapper composes rather than replaces: bytes are still written locally, so get/delete keep
 * working, reads stay byte-exact, non-image blobs (crawled HTML, generated artifacts) never touch the
 * picture gallery, and a Vimeo outage degrades the URL choice instead of failing the upload.
 *
 * Note the import direction: vimeoPictureStorage imports only the TYPE from this module, so there is
 * no runtime cycle despite the mutual reference.
 */
const localObjectStorage = new LocalFileObjectStorage();

export const objectStorage: ObjectStorage = isVimeoStorageConfigured()
  ? new VimeoPictureStorage(localObjectStorage)
  : localObjectStorage;
