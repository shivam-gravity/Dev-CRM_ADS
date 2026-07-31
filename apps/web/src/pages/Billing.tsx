import { currentWorkspaceId } from "../lib/workspace.js";
import { useEffect, useState } from "react";
import { api, Invoice, PaymentMethod, Workspace } from "../api/client.js";
import Reveal from "../components/Reveal.js";

function firstOfMonthISO(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

const PLANS = [
  { id: "starter", name: "Starter Plan", price: "$49/mo", desc: "For small startups launching their first channels. Includes $5k max monthly managed ad spend." },
  { id: "pro", name: "Pro Plan", price: "$149/mo", desc: "For scaling brands and marketing teams. Unlimited ad spend and custom lookalike audience generation." },
  { id: "agency", name: "Agency Plan", price: "$399/mo", desc: "For design and marketing agencies. Includes multi-workspace profiles, team permissions, and reports." }
];

export default function Billing({ businessId }: { businessId: string }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [paymentMethod, setPaymentMethodState] = useState<PaymentMethod | null>(null);
  const [ccNumber, setCcNumber] = useState("");
  const [ccExpiry, setCcExpiry] = useState("");
  const [ccCvc, setCcCvc] = useState("");
  const [savingCard, setSavingCard] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  const wsId = currentWorkspaceId();

  async function refresh() {
    try {
      const [ws, invs, pm] = await Promise.all([
        api.getWorkspace(wsId),
        api.listInvoices(businessId).catch(() => []),
        api.getPaymentMethod(wsId).catch(() => null)
      ]);
      setWorkspace(ws);
      setInvoices(invs);
      setPaymentMethodState(pm);
    } catch {
      setError("Failed to load workspace billing details.");
    }
  }

  useEffect(() => {
    refresh();
  }, [businessId]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      await api.generateInvoice(businessId, firstOfMonthISO(), todayISO());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate invoice");
    } finally {
      setGenerating(false);
    }
  }

  async function handleUpdatePlan(planId: "starter" | "pro" | "agency") {
    setError(null);
    try {
      await api.updateWorkspace(wsId, { plan: planId });
      alert(`Subscription plan updated to ${planId.toUpperCase()}!`);
      await refresh();
    } catch {
      setError("Failed to update subscription tier.");
    }
  }

  async function handleUpdatePayment(e: React.FormEvent) {
    e.preventDefault();
    if (!ccNumber.trim() || !ccExpiry.trim() || !ccCvc.trim()) return;
    setSavingCard(true);
    setCardError(null);
    try {
      const pm = await api.setPaymentMethod(wsId, { cardNumber: ccNumber, expiry: ccExpiry, cvc: ccCvc });
      setPaymentMethodState(pm);
      setCcNumber("");
      setCcExpiry("");
      setCcCvc("");
    } catch (err) {
      setCardError(err instanceof Error ? err.message : "Failed to update payment method.");
    } finally {
      setSavingCard(false);
    }
  }

  return (
    <div className="billing">
      <div className="page-header">
        <div>
          <h1>Billing &amp; Subscription</h1>
          <p className="subtitle">Manage payment plans, upgrade workspaces, and view historical platform invoices.</p>
        </div>
        <button className="btn btn-primary" onClick={handleGenerate} disabled={generating}>
          {generating ? "Syncing..." : "Sync Current Period Invoice"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {/* Plan selection grid */}
      <section className="card mb-4">
        <h2>Subscription Tier</h2>
        <div className="plans-grid mt-3">
          {PLANS.map(p => {
            const isCurrent = workspace?.plan === p.id;
            return (
              <div key={p.id} className={`card plan-card-billing ${isCurrent ? "current-plan" : ""}`}>
                <div className="flex justify-between items-start">
                  <strong>{p.name}</strong>
                  <span className="price-tag font-weight-800">{p.price}</span>
                </div>
                <p className="muted-text font-size-12 mt-2">{p.desc}</p>
                <button
                  className={`btn btn-sm btn-full mt-4 ${isCurrent ? "btn-secondary" : "btn-primary"}`}
                  onClick={() => handleUpdatePlan(p.id as any)}
                  disabled={isCurrent}
                >
                  {isCurrent ? "Current Plan" : "Upgrade Plan"}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* Payment methods & invoices */}
      <div className="billing-layout-split mt-4">
        {/* Credit Card Form */}
        <section className="card">
          <h2>Payment Method</h2>
          {paymentMethod && (
            <p className="muted-text mt-3">
              {paymentMethod.brand.charAt(0).toUpperCase() + paymentMethod.brand.slice(1)} ending in {paymentMethod.last4}, expires {paymentMethod.expiry}
            </p>
          )}
          {cardError && <p className="error">{cardError}</p>}
          <form onSubmit={handleUpdatePayment} className="wizard-form mt-3">
            <label>
              Cardholder Number
              <input
                type="text"
                value={ccNumber}
                onChange={(e) => setCcNumber(e.target.value)}
                placeholder="xxxx xxxx xxxx xxxx"
                required
              />
            </label>
            <div className="form-row-2">
              <label>
                Expiry Date
                <input
                  type="text"
                  value={ccExpiry}
                  onChange={(e) => setCcExpiry(e.target.value)}
                  placeholder="MM/YY"
                  required
                />
              </label>
              <label>
                CVC Security Code
                <input
                  type="text"
                  value={ccCvc}
                  onChange={(e) => setCcCvc(e.target.value)}
                  placeholder="xxx"
                  required
                />
              </label>
            </div>
            <button className="btn btn-primary mt-3" type="submit" disabled={savingCard}>
              {savingCard ? "Updating..." : "Update Credit Card"}
            </button>
          </form>
        </section>

        {/* Invoice table list */}
        <section className="card">
          <h2>Invoices History</h2>
          {invoices.length === 0 ? (
            <p className="muted-text mt-3">No invoices generated yet for this period.</p>
          ) : (
            <div className="table-wrap mt-3">
              <table>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Spend</th>
                    <th>Fee</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id}>
                      <td>
                        {inv.periodStart} → {inv.periodEnd}
                      </td>
                      <td>${(inv.adSpendCents / 100).toFixed(2)}</td>
                      <td>${(inv.platformFeeCents / 100).toFixed(2)}</td>
                      <td>${(inv.totalCents / 100).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
