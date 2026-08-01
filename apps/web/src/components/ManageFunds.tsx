import { useEffect, useRef, useState } from "react";
import { api, type FundsSnapshot } from "../api/client.js";
import { DEFAULT_CURRENCY, formatMoneyMinor, formatMoneyWhole, isZeroDecimalCurrency } from "../constants/money.js";

/**
 * "Manage Funds" — the Ads Manager's funds surface, mirroring the Polluxa CRM's WalletWidget
 * (a compact balance chip in the page header that opens a funds panel). Shows BOTH the connected
 * Meta ad account's REAL billing snapshot (balance, spend, cap, funding source) AND the internal
 * wallet ledger + transactions. "Add Funds" deep-links to Meta's own billing UI — Meta owns the
 * money; this app never holds it — exactly like the CRM does. Only rendered on the Meta network tab.
 */

/**
 * Meta's billing snapshot, unlike the rest of this app, reports TRUE minor units — so a zero-decimal
 * currency arrives as whole units and must not be divided. `formatMoneyWhole` then re-applies the
 * app's own convention. This is why these amounts can't just go through `formatMoneyMinor`.
 */
function formatMinor(minor: number, currency: string): string {
  const divisor = isZeroDecimalCurrency(currency) ? 1 : 100;
  return formatMoneyWhole(minor / divisor, currency);
}

/** Internal wallet ledger amounts, which use the app-wide `wholeUnits * 100` convention. */
function formatCents(cents: number, currency = DEFAULT_CURRENCY): string {
  return formatMoneyMinor(cents, currency);
}

const TX_LABELS: Record<string, string> = {
  top_up: "Top up",
  ad_spend: "Ad spend",
  refund: "Refund",
  adjustment: "Adjustment",
};

export default function ManageFunds({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<FundsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = () => {
    setLoading(true);
    api.getFunds(workspaceId)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  // Load once on mount so the chip can show the balance without opening the panel.
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [workspaceId]);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  const meta = data?.meta ?? null;
  const wallet = data?.wallet ?? null;
  const chipBalance = meta
    ? formatMinor(meta.balanceMinor, meta.currency)
    : wallet
    ? formatCents(wallet.balanceCents, wallet.currency)
    : "—";

  return (
    <div className="manage-funds" ref={ref}>
      <button
        type="button"
        className="manage-funds-chip"
        onClick={() => { if (!open) load(); setOpen((o) => !o); }}
        title="Manage Funds"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <line x1="2" y1="10" x2="22" y2="10" />
        </svg>
        <span className="manage-funds-chip-label">Funds</span>
        <strong className="manage-funds-chip-balance">{chipBalance}</strong>
      </button>

      {open && (
        <div className="manage-funds-panel">
          <div className="manage-funds-panel-head">
            <span className="manage-funds-panel-title">Manage Funds</span>
            {meta?.billingUrl && (
              <a href={meta.billingUrl} target="_blank" rel="noreferrer" className="manage-funds-add-btn">+ Add Funds</a>
            )}
          </div>

          {loading && !data && <p className="manage-funds-muted">Loading…</p>}

          {meta ? (
            <div className="manage-funds-section">
              {/* Balance hero — the number that matters most, given prominence. */}
              <div className="manage-funds-hero">
                <span className="manage-funds-hero-label">Available balance</span>
                <span className="manage-funds-hero-value">{formatMinor(meta.balanceMinor, meta.currency)}</span>
              </div>

              {/* Secondary figures as clean label → value rows (no cramped grid). */}
              <dl className="manage-funds-rows">
                <div className="manage-funds-row">
                  <dt>Lifetime spend</dt>
                  <dd>{formatMinor(meta.amountSpentMinor, meta.currency)}</dd>
                </div>
                {meta.spendCapMinor != null && (
                  <div className="manage-funds-row">
                    <dt>Spend cap</dt>
                    <dd>{formatMinor(meta.spendCapMinor, meta.currency)}</dd>
                  </div>
                )}
                <div className="manage-funds-row">
                  <dt>Payment method</dt>
                  <dd>{meta.fundingSource ?? "—"}</dd>
                </div>
              </dl>

              <p className="manage-funds-source-note">
                Meta ad account <code>act_{meta.adAccountId}</code>{meta.accountStatus ? ` · ${meta.accountStatus}` : ""} — billed directly by Meta.
              </p>
            </div>
          ) : (
            !loading && (
              <p className="manage-funds-muted">
                No Meta ad account connected — showing the workspace wallet only. Connect Meta to see the real ad-account balance.
              </p>
            )
          )}

          {wallet && (
            <div className="manage-funds-wallet">
              <div className="manage-funds-wallet-head">
                <span>Workspace wallet</span>
                <strong>{formatCents(wallet.balanceCents, wallet.currency)}</strong>
              </div>
              {(data?.transactions?.length ?? 0) > 0 ? (
                <ul className="manage-funds-tx">
                  {data!.transactions.slice(0, 8).map((t) => (
                    <li key={t.id} className="manage-funds-tx-row">
                      <span className={`manage-funds-tx-type manage-funds-tx-${t.type}`}>{TX_LABELS[t.type] ?? t.type}</span>
                      <span className="manage-funds-tx-desc">{t.description}</span>
                      <span className={`manage-funds-tx-amt ${t.amountCents < 0 ? "neg" : "pos"}`}>
                        {t.amountCents < 0 ? "−" : "+"}{formatCents(Math.abs(t.amountCents), wallet.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="manage-funds-muted">No wallet transactions yet.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
