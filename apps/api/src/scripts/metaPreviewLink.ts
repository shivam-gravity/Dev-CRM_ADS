/**
 * Prints a no-login ad preview URL for a live ad + the Ads Manager deep link.
 *   npx tsx src/scripts/metaPreviewLink.ts <workspaceId> <adId> <campaignId>
 */
import "dotenv/config";
import { getMetaCredentials } from "../modules/integrations/integrationService.js";

const GRAPH = "https://graph.facebook.com/v22.0";
async function gget(path: string, token: string): Promise<any> {
  const res = await fetch(`${GRAPH}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`);
  return res.json();
}

async function main() {
  const [ws, adId, campaignId] = process.argv.slice(2);
  const creds = await getMetaCredentials(ws);
  if (!creds) throw new Error(`No Meta credentials for ${ws}`);
  const token = creds.accessToken;
  const acct = String(creds.adAccountId).replace(/^act_/, "");

  // A live ad exposes a set of preview iframes (one per format). These render the real
  // creative exactly as it serves on Facebook/Instagram — no login required to view.
  const prev = await gget(`/${adId}/previews?ad_format=DESKTOP_FEED_STANDARD`, token);
  const body: string = prev?.data?.[0]?.body ?? "";
  const m = body.match(/src="([^"]+)"/);
  const iframeSrc = m ? m[1].replace(/&amp;/g, "&") : null;
  console.log("PREVIEW_IFRAME_URL:", iframeSrc ?? `(none — ${JSON.stringify(prev).slice(0, 300)})`);
  console.log("ADS_MANAGER_URL:", `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${acct}&selected_campaign_ids=${campaignId}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => process.exit(0));
