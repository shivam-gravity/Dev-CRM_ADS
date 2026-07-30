import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 * Absolute directory holding every stored blob. Exported so the /objects static route in index.ts
 * serves exactly what this module writes, instead of computing the same path a second time.
 *
 * That duplication was a real bug, and a quiet one. Both places derived the directory from their own
 * `__dirname`, at different nesting depths that happen to cancel out in the source tree — but the
 * Docker image copies apps/api/dist to /repo/service/dist (see docker/Dockerfile.node-service), which
 * drops the "apps/api" segment. So in a container both resolved to /repo/service/data/objects while
 * the compose volume was mounted at /repo/service/apps/api/data/objects: uploads went to the
 * container's ephemeral layer and were destroyed on every rebuild, leaving the /objects URL in
 * Postgres pointing at nothing (broken thumbnails).
 *
 * OBJECT_STORAGE_DIR lets the deployment state the path outright rather than depend on it being
 * re-derived correctly. Read at import time, so it must be set before this module loads.
 */
export const OBJECTS_ROOT =
  process.env.OBJECT_STORAGE_DIR?.trim() || path.resolve(__dirname, "../../data/objects");

/**
 * Writes to OBJECTS_ROOT (apps/api/data/objects by default) and serves files back out via the
 * /objects static route mounted in src/index.ts. Good enough for a single-host deployment; a real
 * multi-host one swaps this for an S3/GCS/R2 client behind the same interface.
 */
export class LocalFileObjectStorage implements ObjectStorage {
  constructor(
    private readonly rootDir = OBJECTS_ROOT,
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
 * Server disk is the one and only substrate. Uploaded images, generated creatives and crawl artifacts
 * all live under OBJECTS_ROOT and are served back at /objects/<key>.
 *
 * An earlier version optionally mirrored images to a third-party CDN and returned that URL instead.
 * Nothing needs it: the one place that must hand an image to an external service — Meta's /adimages —
 * reads the bytes off this disk and uploads them directly (see resolveMetaImageUpload in
 * modules/orchestrator/campaignOrchestrator.ts), so a publicly fetchable URL was never required.
 *
 * The corollary is that this directory must be durable. In Docker it has to be a mounted volume at
 * exactly OBJECTS_ROOT, and every container that WRITES objects needs the same mount, or a key
 * written by a worker is unreadable by the api. See the x-objects-volume anchor in docker-compose.yml.
 */
export const objectStorage: ObjectStorage = new LocalFileObjectStorage();
