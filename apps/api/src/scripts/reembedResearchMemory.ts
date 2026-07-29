import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db/prisma.js";
import { embeddingDimensions } from "../infra/geminiClient.js";

/**
 * Clears stored Research Memory vectors after an embedding-model change, so they get re-embedded
 * on the current model as research runs again.
 *
 * WHY THIS IS MANDATORY, NOT HOUSEKEEPING. ResearchMemoryStore.cosineSimilarity guards against
 * comparing vectors from different embedding models by checking their LENGTHS and scoring 0 on a
 * mismatch. That guard silently fails when the old and new models share a width: the LLM backend
 * moved from Titan Text Embeddings V2 to Gemini embeddings and BOTH are configured at 1024 dims
 * (deliberately, so the Float[] column needed no schema change). Same width means the guard sees
 * nothing wrong and happily computes a cosine score between two vectors from different embedding
 * spaces — which is not a similarity, just noise that outranks or buries genuine matches. Deleting
 * the pre-switch rows is what makes the store correct again; they rebuild automatically.
 *
 * Every deleted row is written to a timestamped JSON backup FIRST (embeddings included), so a
 * mistaken run is recoverable. Idempotent: once clean, subsequent runs report 0.
 *
 * Flags:
 *   --dry-run          count + write the backup, run NO deletes.
 *   --yes              required to actually delete (guard against an accidental invocation).
 *   --workspace=<id>   limit to one workspace instead of every row.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = path.join(__dirname, "..", "..", "data", "migrations");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const CONFIRMED = argv.includes("--yes");
const workspaceId = argv.find((a) => a.startsWith("--workspace="))?.split("=")[1];

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const where = workspaceId ? { workspaceId } : {};
  const rows = await prisma.researchMemoryEntry.findMany({ where });

  console.log(`research_memory_entries in scope: ${rows.length}${workspaceId ? ` (workspace ${workspaceId})` : " (all workspaces)"}`);
  console.log(`current embedding width: ${embeddingDimensions()} dims`);

  if (rows.length === 0) {
    console.log("nothing to clear — already re-embedded (or empty).");
    return;
  }

  // Report the widths present. Rows already at the current width are indistinguishable from
  // post-switch rows, which is exactly why this script deletes by scope rather than by width.
  const widths = new Map<number, number>();
  for (const r of rows) widths.set(r.embedding.length, (widths.get(r.embedding.length) ?? 0) + 1);
  for (const [width, count] of [...widths.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count} row(s) at ${width} dims`);
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(BACKUP_DIR, `research-memory-backup-${stamp()}.json`);
  writeFileSync(backupPath, JSON.stringify(rows, null, 2), "utf8");
  console.log(`backup written: ${backupPath}`);

  if (DRY_RUN) {
    console.log("--dry-run: no rows deleted.");
    return;
  }
  if (!CONFIRMED) {
    console.log(`refusing to delete ${rows.length} row(s) without --yes. Re-run with --yes to proceed.`);
    process.exitCode = 1;
    return;
  }

  const { count } = await prisma.researchMemoryEntry.deleteMany({ where });
  console.log(`deleted ${count} row(s). They will be re-embedded on the current model as research runs.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
