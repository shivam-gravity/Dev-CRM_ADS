/**
 * Pauses a Meta campaign (which gates all delivery/spend under it), then re-reads
 * effective_status on the ad to confirm nothing is delivering. Reverse of activateMetaChain.
 *   npx tsx src/scripts/pauseMetaChain.ts <workspaceId> <campaignId> <adSetId> <adId>
 */
import "dotenv/config";
import { getMetaCredentials } from "../modules/integrations/integrationService.js";

const GRAPH = "https://graph.facebook.com/v22.0";
async function gget(path: string, token: string): Promise<any> {
  const res = await fetch(`${GRAPH}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`);
  return res.json();
}
async function setPaused(id: string, token: string): Promise<any> {
  const res = await fetch(`${GRAPH}/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "PAUSED", access_token: token }),
  });
  return res.json();
}

async function main() {
  const [ws, campaignId, adSetId, adId] = process.argv.slice(2);
  const creds = await getMetaCredentials(ws);
  if (!creds) throw new Error(`No Meta credentials for ${ws}`);
  const token = creds.accessToken;

  // Pause child-first so no window exists where an active ad set has a paused campaign flapping.
  for (const [label, id] of [["AD", adId], ["AD SET", adSetId], ["CAMPAIGN", campaignId]] as const) {
    if (!id) continue;
    const r = await setPaused(id, token);
    console.log(`PAUSE ${label} ${id}:`, JSON.stringify(r));
    if (r?.error) throw new Error(`${label} pause failed: ${r.error.message}`);
  }

  const ad = await gget(
    `/${adId}?fields=id,status,effective_status,adset{id,status,effective_status},campaign{id,status,effective_status}`,
    token,
  );
  console.log("\nVERIFY:", JSON.stringify(ad, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => process.exit(0));
