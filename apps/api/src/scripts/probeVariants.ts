import "dotenv/config";
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const ids = process.argv.slice(2);
for (const id of ids) {
  const c = await p.campaign.findUnique({ where: { id } });
  const d: any = c?.data ?? {};
  console.log(`\n=== ${id} — "${d.name}" status=${d.status} budget=${d.dailyBudgetCents} networks=${JSON.stringify(d.networks)} ===`);
  console.log("externalCampaignId:", d.externalCampaignId ?? d.externalId ?? "(none)");
  const variants: any[] = Array.isArray(d.variants) ? d.variants : [];
  for (const v of variants) {
    console.log("  variant:", JSON.stringify({
      id: v.id, network: v.network, status: v.status,
      externalId: v.externalId, externalAdId: v.externalAdId, externalAdSetId: v.externalAdSetId,
      audienceName: v.audienceName, hasCreative: !!(v.creative || v.headline || v.primaryText),
    }));
  }
}
await p.$disconnect();
