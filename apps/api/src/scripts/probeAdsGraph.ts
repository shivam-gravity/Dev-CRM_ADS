import "dotenv/config";
import { getMetaCredentials } from "../modules/integrations/integrationService.js";

const GRAPH = "https://graph.facebook.com/v22.0";
async function gget(path: string, token: string): Promise<any> {
  const res = await fetch(`${GRAPH}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`);
  return res.json();
}

async function main() {
  const ws = "crm-biz-1";
  const creds = await getMetaCredentials(ws);
  if (!creds) throw new Error("no creds");
  const token = creds.accessToken;
  const adIds = process.argv.slice(2);
  for (const adId of adIds) {
    // Ad -> adset (with budget + effective_status) -> campaign
    const ad = await gget(`/${adId}?fields=id,name,status,effective_status,adset{id,name,status,effective_status,daily_budget,lifetime_budget},campaign{id,name,status,effective_status,daily_budget}`, token);
    console.log(JSON.stringify(ad));
  }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => process.exit(0));
