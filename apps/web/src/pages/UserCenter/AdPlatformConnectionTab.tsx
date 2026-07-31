import { currentWorkspaceId } from "../../lib/workspace.js";
import { useEffect, useState } from "react";
import { api, Integration } from "../../api/client.js";
import { MetaInfinityIcon, GoogleIcon, TikTokIcon, BingIcon } from "../../components/icons.js";

type ManualPlatform = "meta" | "google";

/**
 * Wording for the OAuth error codes the callback routes redirect back with. The *_not_configured
 * codes are deliberately separate from the generic failure: a deployment with no OAuth app
 * registered will NEVER succeed by retrying, and "Please try again" just sends the user in circles.
 * These messages name the manual path instead, which is the only thing that actually works there.
 */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  meta_not_configured:
    'Meta OAuth isn\'t set up on this deployment, so "Connect Meta" can\'t reach Facebook. Use "Connect manually" below with an access token — a Business Manager System User token is recommended, since it doesn\'t expire.',
  google_not_configured:
    'Google OAuth isn\'t set up on this deployment, so "Connect Google" can\'t reach Google. Use "Connect manually" below with your Customer ID, Developer Token and Access Token.',
};

const EMPTY_META_MANUAL_FORM = { accessToken: "", adAccountId: "", pageId: "", pageAccessToken: "" };
const EMPTY_GOOGLE_MANUAL_FORM = { customerId: "", developerToken: "", accessToken: "", clientId: "", clientSecret: "", refreshToken: "" };

function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}

/** Google customer IDs are stored as raw digits ("1234567890") — display them in Google's own dashed convention ("123-456-7890"). */
function formatGoogleCustomerId(id: string): string {
  const digits = id.replace(/\D/g, "");
  if (digits.length !== 10) return id;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/**
 * Shows how many characters a masked field currently holds.
 *
 * This exists because of a real failure: two Meta tokens for the same account shared a long common
 * prefix (Meta tokens all begin with the same app-derived run of characters) and differed only in
 * length — one 236 chars, the other 205. They were pasted into two adjacent password fields and the
 * wrong one kept being submitted. Dots look identical, so there was no way to tell which token a
 * field held without revealing it — and the resulting error ("the token has expired") pointed at the
 * credential rather than at the mix-up. A character count leaks nothing and makes two
 * similar-looking tokens instantly distinguishable.
 */
function FieldLength({ value }: { value: string }) {
  if (!value) return null;
  return <div className="field-hint">{value.length} characters</div>;
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="ad-account-card-row">
      <span className="ad-account-card-row-label">{label}</span>
      <span className="ad-account-card-row-value">{value}</span>
    </div>
  );
}

export default function AdPlatformConnectionTab({ businessId: _businessId }: { businessId: string }) {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conversionActionCount, setConversionActionCount] = useState<number | null>(null);

  const [manualPlatform, setManualPlatform] = useState<ManualPlatform | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [metaManualForm, setMetaManualForm] = useState(EMPTY_META_MANUAL_FORM);
  const [googleManualForm, setGoogleManualForm] = useState(EMPTY_GOOGLE_MANUAL_FORM);
  const [revealedTokens, setRevealedTokens] = useState<Record<string, boolean>>({});

  function toggleTokenReveal(key: string) {
    setRevealedTokens((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const wsId = currentWorkspaceId();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setIntegrations(await api.listIntegrations(wsId));
    } catch {
      setError("Failed to fetch platform integrations.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.search);
    const errorCode = params.get("error");
    if (params.get("connected") === "meta" || params.get("connected") === "google" || errorCode) {
      if (errorCode) setError(OAUTH_ERROR_MESSAGES[errorCode] ?? "Failed to connect platform. Please try again.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const metaIntegration = integrations.find((i) => i.platform === "meta");
  const googleIntegration = integrations.find((i) => i.platform === "google");
  const metaConnected = metaIntegration?.status === "connected";
  const googleConnected = googleIntegration?.status === "connected";

  // A PLACEHOLDER connection, written by the server's mockConnect* path when no app credentials
  // (META_APP_ID/META_APP_SECRET, or the Google equivalents) are configured — clicking "Connect"
  // then never round-trips to the provider and stores a fake token instead. It has status
  // "connected", so without this flag the card renders a green "Connected" pill for an account
  // that cannot publish a single ad, and the manual-connect form (the way OUT of this state) stays
  // hidden behind the not-connected branch.
  const metaIsMock = Boolean(metaIntegration?.settings?.mock);
  const googleIsMock = Boolean(googleIntegration?.settings?.mock);

  useEffect(() => {
    if (!googleConnected) {
      setConversionActionCount(null);
      return;
    }
    api.listGoogleConversionActions(wsId).then((list) => setConversionActionCount(list.length)).catch(() => setConversionActionCount(null));
  }, [googleConnected, wsId]);

  function startOAuthConnect(platform: ManualPlatform) {
    window.location.href = platform === "meta" ? api.startMetaOAuth(wsId) : api.startGoogleOAuth(wsId);
  }

  function toggleManualForm(platform: ManualPlatform) {
    setManualError(null);
    const opening = manualPlatform !== platform;
    if (opening) {
      // Always start from empty. A browser can autofill a saved credential into a masked field after
      // mount — the value updates, the dots don't visibly change — so a form reopened later could
      // submit a stale token while appearing to hold what was just typed. Resetting on open means
      // whatever is submitted is something the user put there during THIS interaction.
      if (platform === "meta") setMetaManualForm(EMPTY_META_MANUAL_FORM);
      else setGoogleManualForm(EMPTY_GOOGLE_MANUAL_FORM);
      setRevealedTokens({});
    }
    setManualPlatform(opening ? platform : null);
  }

  async function handleManualConnect(platform: ManualPlatform) {
    setManualError(null);
    setManualSubmitting(true);
    try {
      if (platform === "meta") {
        if (!metaManualForm.accessToken || !metaManualForm.adAccountId) {
          setManualError("Access Token and Ad Account ID are required.");
          return;
        }
        await api.connectMetaManual(wsId, {
          accessToken: metaManualForm.accessToken,
          adAccountId: metaManualForm.adAccountId,
          pageId: metaManualForm.pageId || undefined,
          pageAccessToken: metaManualForm.pageAccessToken || undefined,
        });
        setMetaManualForm(EMPTY_META_MANUAL_FORM);
      } else {
        if (!googleManualForm.customerId || !googleManualForm.developerToken || !googleManualForm.accessToken) {
          setManualError("Customer ID, Developer Token, and Access Token are required.");
          return;
        }
        await api.connectGoogleManual(wsId, {
          customerId: googleManualForm.customerId,
          developerToken: googleManualForm.developerToken,
          accessToken: googleManualForm.accessToken,
          clientId: googleManualForm.clientId || undefined,
          clientSecret: googleManualForm.clientSecret || undefined,
          refreshToken: googleManualForm.refreshToken || undefined,
        });
        setGoogleManualForm(EMPTY_GOOGLE_MANUAL_FORM);
      }
      setManualPlatform(null);
      await load();
    } catch (err) {
      // Surface the provider's OWN message. The connect routes now validate against Meta/Google
      // before persisting, so this text names which credential is wrong (or which ad account the
      // token can't see) — swallowing it would leave the user guessing across four fields, which is
      // exactly the problem validation was added to solve.
      setManualError(err instanceof Error && err.message ? err.message : "Manual connect failed. Double-check the values and try again.");
    } finally {
      setManualSubmitting(false);
    }
  }

  async function handleDisconnect(platform: ManualPlatform) {
    if (!confirm("Disconnect this platform? Syncing campaigns will pause.")) return;
    setError(null);
    try {
      await api.disconnectIntegration(wsId, platform);
      await load();
    } catch {
      setError("Failed to disconnect platform.");
    }
  }

  function renderManualForm(platform: ManualPlatform) {
    return (
      <div className="platform-connect-manual-inline">
        {manualError && <p className="error">{manualError}</p>}
        {platform === "meta" ? (
          <>
            <p className="muted-text">
              Paste tokens from the{" "}
              <a href="https://developers.facebook.com/tools/explorer" target="_blank" rel="noreferrer">Meta Graph API Explorer</a>.
            </p>
            <label className="polluxa-modal-field">
              <span>Access Token — must have ads_management</span>
              <div className="token-reveal-field">
                <input
                  type={revealedTokens.metaAccessToken ? "text" : "password"}
                  autoComplete="new-password"
                  value={metaManualForm.accessToken}
                  onChange={(e) => setMetaManualForm((f) => ({ ...f, accessToken: e.target.value }))}
                />
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => toggleTokenReveal("metaAccessToken")}>
                  {revealedTokens.metaAccessToken ? "Hide" : "Reveal"}
                </button>
              </div>
              <FieldLength value={metaManualForm.accessToken} />
              <div className="field-hint">
                A <strong>Page</strong> token with ads permissions works here, not just a User token — and a System User token is best,
                since it never expires. Reveal and check the character count if two of your tokens look alike.
              </div>
            </label>
            <label className="polluxa-modal-field">
              <span>Ad Account ID (e.g. act_123456)</span>
              <input type="text" autoComplete="off" value={metaManualForm.adAccountId} onChange={(e) => setMetaManualForm((f) => ({ ...f, adAccountId: e.target.value }))} />
            </label>
            <label className="polluxa-modal-field">
              <span>Page ID</span>
              <input type="text" autoComplete="off" value={metaManualForm.pageId} onChange={(e) => setMetaManualForm((f) => ({ ...f, pageId: e.target.value }))} />
            </label>
            <label className="polluxa-modal-field">
              <span>Page Access Token — optional</span>
              <div className="token-reveal-field">
                <input
                  type={revealedTokens.metaPageAccessToken ? "text" : "password"}
                  autoComplete="new-password"
                  value={metaManualForm.pageAccessToken}
                  onChange={(e) => setMetaManualForm((f) => ({ ...f, pageAccessToken: e.target.value }))}
                />
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => toggleTokenReveal("metaPageAccessToken")}>
                  {revealedTokens.metaPageAccessToken ? "Hide" : "Reveal"}
                </button>
              </div>
              <FieldLength value={metaManualForm.pageAccessToken} />
              <div className="field-hint">
                <strong>Leave this empty</strong> unless you have a separate page token — the Access Token above is reused for the page,
                which works whenever it already carries page permissions. Only needed for lead-form capture with a distinct page token.
              </div>
            </label>
          </>
        ) : (
          <>
            <p className="muted-text">Paste credentials from the Google Ads API Center.</p>
            <label className="polluxa-modal-field">
              <span>Customer ID (e.g. 123-456-7890)</span>
              <input type="text" autoComplete="off" value={googleManualForm.customerId} onChange={(e) => setGoogleManualForm((f) => ({ ...f, customerId: e.target.value }))} />
            </label>
            <label className="polluxa-modal-field">
              <span>Developer Token</span>
              <input type="password" autoComplete="new-password" value={googleManualForm.developerToken} onChange={(e) => setGoogleManualForm((f) => ({ ...f, developerToken: e.target.value }))} />
            </label>
            <label className="polluxa-modal-field">
              <span>Access Token</span>
              <div className="token-reveal-field">
                <input
                  type={revealedTokens.googleAccessToken ? "text" : "password"}
                  autoComplete="new-password"
                  value={googleManualForm.accessToken}
                  onChange={(e) => setGoogleManualForm((f) => ({ ...f, accessToken: e.target.value }))}
                />
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => toggleTokenReveal("googleAccessToken")}>
                  {revealedTokens.googleAccessToken ? "Hide" : "Reveal"}
                </button>
              </div>
              <FieldLength value={googleManualForm.accessToken} />
            </label>
            <label className="polluxa-modal-field">
              <span>Client ID (optional)</span>
              <input type="text" autoComplete="off" value={googleManualForm.clientId} onChange={(e) => setGoogleManualForm((f) => ({ ...f, clientId: e.target.value }))} />
            </label>
            <label className="polluxa-modal-field">
              <span>Client Secret (optional)</span>
              <input type="password" autoComplete="new-password" value={googleManualForm.clientSecret} onChange={(e) => setGoogleManualForm((f) => ({ ...f, clientSecret: e.target.value }))} />
            </label>
            <label className="polluxa-modal-field">
              <span>Refresh Token (optional)</span>
              <div className="token-reveal-field">
                <input
                  type={revealedTokens.googleRefreshToken ? "text" : "password"}
                  autoComplete="new-password"
                  value={googleManualForm.refreshToken}
                  onChange={(e) => setGoogleManualForm((f) => ({ ...f, refreshToken: e.target.value }))}
                />
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => toggleTokenReveal("googleRefreshToken")}>
                  {revealedTokens.googleRefreshToken ? "Hide" : "Reveal"}
                </button>
              </div>
              <div className="field-hint">Without this, CRM Ads can't refresh the token once it expires (~1hr) — you'll need to reconnect.</div>
            </label>
          </>
        )}
        <button type="button" className="btn btn-primary polluxa-modal-submit" onClick={() => handleManualConnect(platform)} disabled={manualSubmitting}>
          {manualSubmitting ? "Connecting..." : "Connect manually"}
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="platform-connect">
        <div className="campaigns-loading">
          <div className="campaign-row-skeleton" />
          <div className="campaign-row-skeleton" />
        </div>
      </div>
    );
  }

  return (
    <div className="platform-connect">
      {error && <p className="error">{error}</p>}

      <div className="ad-account-cards-grid">
        <section className="card ad-account-card">
          <div className="ad-account-card-header">
            <MetaInfinityIcon />
            <h3>Meta Ads</h3>
            <span className={`ad-account-status-pill ${metaConnected && !metaIsMock ? "connected" : "disconnected"}`}>
              <span className="live-dot" /> {metaIsMock ? "Demo only" : metaConnected ? "Connected" : "Not connected"}
            </span>
          </div>

          {metaConnected && metaIntegration ? (
            <>
              {metaIsMock && (
                <p className="error">
                  Placeholder connection — no Meta App credentials are configured on the server, so
                  &ldquo;Connect Meta&rdquo; stored a demo token instead of contacting Facebook. This
                  cannot publish ads. Paste a real token below to replace it.
                </p>
              )}
              <div className="ad-account-card-details">
                {Boolean(metaIntegration.settings?.businessName) && <DetailRow label="Business" value={String(metaIntegration.settings.businessName)} />}
                {metaIntegration.accountName && <DetailRow label="Ad Account" value={metaIntegration.accountName} />}
                {Boolean(metaIntegration.settings?.pageName) && <DetailRow label="Page" value={String(metaIntegration.settings.pageName)} />}
                {Boolean(metaIntegration.settings?.instagramUsername) && <DetailRow label="Instagram" value={`@${String(metaIntegration.settings.instagramUsername)}`} />}
                <DetailRow label="Last synced" value={timeAgo(metaIntegration.updatedAt)} />
              </div>
              <div className="ad-account-card-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => startOAuthConnect("meta")}>Reconnect</button>
                <button type="button" className="platform-connect-btn danger" onClick={() => handleDisconnect("meta")}>Disconnect</button>
              </div>
              {/* A placeholder connection has status "connected", so without this the manual form —
                  the only way to get a real token in when no app credentials exist — would be
                  unreachable without disconnecting first. */}
              {metaIsMock && (
                <>
                  <button type="button" className="platform-connect-manual-toggle" onClick={() => toggleManualForm("meta")}>
                    {manualPlatform === "meta" ? "Hide manual connect" : "Replace with a real token"}
                  </button>
                  {manualPlatform === "meta" && renderManualForm("meta")}
                </>
              )}
            </>
          ) : (
            <>
              <p className="muted-text">Connect your Meta Business account to launch and sync ads.</p>
              <button type="button" className="btn btn-primary platform-connect-oauth-btn" onClick={() => startOAuthConnect("meta")}>
                <MetaInfinityIcon /> Connect Meta
              </button>
              <button type="button" className="platform-connect-manual-toggle" onClick={() => toggleManualForm("meta")}>
                {manualPlatform === "meta" ? "Hide manual connect" : "Have a token already? Connect manually instead"}
              </button>
              {manualPlatform === "meta" && renderManualForm("meta")}
            </>
          )}
        </section>

        <section className="card ad-account-card">
          <div className="ad-account-card-header">
            <GoogleIcon />
            <h3>Google Ads</h3>
            <span className={`ad-account-status-pill ${googleConnected && !googleIsMock ? "connected" : "disconnected"}`}>
              <span className="live-dot" /> {googleIsMock ? "Demo only" : googleConnected ? "Connected" : "Not connected"}
            </span>
          </div>

          {googleConnected && googleIntegration ? (
            <>
              {googleIsMock && (
                <p className="error">
                  Placeholder connection — no Google OAuth credentials are configured on the server,
                  so &ldquo;Connect Google&rdquo; stored a demo token. This cannot publish campaigns.
                  Paste real credentials below to replace it.
                </p>
              )}
              <div className="ad-account-card-details">
                {googleIntegration.accountId && <DetailRow label="Customer" value={formatGoogleCustomerId(googleIntegration.accountId)} />}
                <DetailRow label="Conversion Actions" value={conversionActionCount ?? "…"} />
                <DetailRow label="Last synced" value={timeAgo(googleIntegration.updatedAt)} />
              </div>
              <div className="ad-account-card-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => startOAuthConnect("google")}>Reconnect</button>
                <button type="button" className="platform-connect-btn danger" onClick={() => handleDisconnect("google")}>Disconnect</button>
              </div>
              {googleIsMock && (
                <>
                  <button type="button" className="platform-connect-manual-toggle" onClick={() => toggleManualForm("google")}>
                    {manualPlatform === "google" ? "Hide manual connect" : "Replace with real credentials"}
                  </button>
                  {manualPlatform === "google" && renderManualForm("google")}
                </>
              )}
            </>
          ) : (
            <>
              <p className="muted-text">Connect your Google Ads account to launch and sync campaigns.</p>
              <button type="button" className="btn btn-primary platform-connect-oauth-btn" onClick={() => startOAuthConnect("google")}>
                <GoogleIcon /> Connect Google
              </button>
              <button type="button" className="platform-connect-manual-toggle" onClick={() => toggleManualForm("google")}>
                {manualPlatform === "google" ? "Hide manual connect" : "Have a token already? Connect manually instead"}
              </button>
              {manualPlatform === "google" && renderManualForm("google")}
            </>
          )}
        </section>
      </div>

      <div className="ad-account-coming-soon-row">
        <span className="muted-text">More platforms:</span>
        <span className="ad-account-coming-soon-chip"><TikTokIcon /> TikTok — coming soon</span>
        <span className="ad-account-coming-soon-chip"><BingIcon /> Bing — coming soon</span>
      </div>
    </div>
  );
}
