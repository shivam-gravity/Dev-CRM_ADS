/**
 * Activates a full Meta object chain (campaign -> ad set -> ad) to ACTIVE on the real
 * Graph API, then re-reads effective_status to confirm real delivery. INR spend starts
 * once all three are ACTIVE. Prints only non-sensitive object fields, never the token.
 *
 *   npx tsx src/scripts/activateMetaChain.ts <workspaceId> <campaignId> <adSetId> <adId>
 */
import "dotenv/config";
import { getMetaCredentials } from "../modules/integrations/integrationService.js";

const GRAPH = "https://graph.facebook.com/v22.0";

async function gget(path: string, token: string): Promise<any> {
  const res = await fetch(`${GRAPH}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`);
  return res.json();
}
async function setActive(id: string, token: string): Promise<any> {
  const res = await fetch(`${GRAPH}/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "ACTIVE", access_token: token }),
  });
  return res.json();
}

async function main() {
  const [ws, campaignId, adSetId, adId] = process.argv.slice(2);
  const creds = await getMetaCredentials(ws);
  if (!creds) throw new Error(`No Meta credentials for ${ws}`);
  const token = creds.accessToken;

  // Order: campaign -> ad set -> ad, so the parent is never PAUSED when the child goes live.
  for (const [label, id] of [["CAMPAIGN", campaignId], ["AD SET", adSetId], ["AD", adId]] as const) {
    const r = await setActive(id, token);
    console.log(`ACTIVATE ${label} ${id}:`, JSON.stringify(r));
    if (r?.error) throw new Error(`${label} activation failed: ${r.error.message}`);
  }

  // Verify true delivery state from Meta's side.
  const ad = await gget(
    `/${adId}?fields=id,status,effective_status,adset{id,status,effective_status,daily_budget},campaign{id,status,effective_status}`,
    token,
  );
  console.log("\nVERIFY:", JSON.stringify(ad, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => process.exit(0));
