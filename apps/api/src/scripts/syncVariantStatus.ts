/**
 * Syncs one campaign's DB status + a variant's status to match what's live on Meta.
 *   npx tsx src/scripts/syncVariantStatus.ts <campaignId> <variantExternalId> <newStatus>
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

async function main() {
  const [campaignId, variantExternalId, status] = process.argv.slice(2);
  const c = await p.campaign.findUnique({ where: { id: campaignId } });
  if (!c) throw new Error(`Campaign ${campaignId} not found`);
  const d: any = c.data ?? {};
  d.status = status;
  for (const v of (Array.isArray(d.variants) ? d.variants : [])) {
    if (v.externalId === variantExternalId) v.status = status;
  }
  await p.campaign.update({ where: { id: campaignId }, data: { data: d } });
  console.log(`Synced campaign ${campaignId} -> status=${status}; variant ${variantExternalId} -> ${status}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
