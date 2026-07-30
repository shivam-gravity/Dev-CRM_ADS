import { useEffect, useState } from "react";
import Reveal from "../components/Reveal.js";
import { api, AutomationRule as ApiAutomationRule } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { formatMoneyWhole } from "../constants/money.js";
import { useCurrency } from "../providers/CurrencyProvider.js";

interface AutomationRule {
  id: string;
  name: string;
  triggerMetric: "CPA" | "CTR" | "ROAS" | "Spend";
  operator: ">" | "<" | "=";
  threshold: number;
  action: "Pause Campaign" | "Increase Budget" | "Duplicate Campaign" | "Notify Team";
  actionValue?: string;
  cooldown: string;
  priority: "High" | "Medium" | "Low";
  enabled: boolean;
}

const METRIC_TO_API: Record<AutomationRule["triggerMetric"], string> = {
  CPA: "CPA",
  CTR: "CTR",
  ROAS: "ROAS",
  Spend: "Spend"
};

const OPERATOR_TO_API: Record<AutomationRule["operator"], "gt" | "lt" | "eq"> = {
  ">": "gt",
  "<": "lt",
  "=": "eq"
};

const OPERATOR_FROM_API: Record<"gt" | "lt" | "eq", AutomationRule["operator"]> = {
  gt: ">",
  lt: "<",
  eq: "="
};

const PRIORITY_TO_API: Record<AutomationRule["priority"], "low" | "medium" | "high"> = {
  High: "high",
  Medium: "medium",
  Low: "low"
};

const PRIORITY_FROM_API: Record<"low" | "medium" | "high", AutomationRule["priority"]> = {
  low: "Low",
  medium: "Medium",
  high: "High"
};

function cooldownToMinutes(cooldown: string): number {
  if (cooldown.endsWith("d")) return parseInt(cooldown, 10) * 24 * 60;
  if (cooldown.endsWith("h")) return parseInt(cooldown, 10) * 60;
  return parseInt(cooldown, 10) || 0;
}

function cooldownFromMinutes(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function fromApiRule(r: ApiAutomationRule): AutomationRule {
  return {
    id: r.id,
    name: r.name,
    triggerMetric: (r.metric as AutomationRule["triggerMetric"]) ?? "CPA",
    operator: OPERATOR_FROM_API[r.operator] ?? ">",
    threshold: r.thresholdValue,
    action: r.action as AutomationRule["action"],
    actionValue: r.actionParam,
    cooldown: cooldownFromMinutes(r.cooldownMinutes),
    priority: PRIORITY_FROM_API[r.priority] ?? "Medium",
    enabled: r.enabled
  };
}

const THRESHOLD_MIN = 0;
const THRESHOLD_MAX = 1000000;

const DEFAULT_RULES: AutomationRule[] = [
  {
    id: "rule-1",
    name: "Pause High CPA Campaigns",
    triggerMetric: "CPA",
    operator: ">",
    threshold: 40,
    action: "Pause Campaign",
    cooldown: "24h",
    priority: "High",
    enabled: true
  },
  {
    id: "rule-2",
    name: "Reward High CTR Creatives",
    triggerMetric: "CTR",
    operator: ">",
    threshold: 5,
    action: "Increase Budget",
    actionValue: "20%",
    cooldown: "12h",
    priority: "Medium",
    enabled: true
  },
  {
    id: "rule-3",
    name: "Scale Winning Ads (ROAS)",
    triggerMetric: "ROAS",
    operator: ">",
    threshold: 6,
    action: "Duplicate Campaign",
    cooldown: "48h",
    priority: "High",
    enabled: false
  }
];

export default function AutomationRules({ businessId }: { businessId: string }) {
  const { currency } = useCurrency();
  const { workspaceId: authWorkspaceId } = useAuth();
  const workspaceId = authWorkspaceId ?? localStorage.getItem("polluxa_workspace_id") ?? "demo-workspace";

  const [rules, setRules] = useState<AutomationRule[]>(DEFAULT_RULES);
  const [showAddForm, setShowAddForm] = useState(false);

  // Rule builder states
  const [name, setName] = useState("");
  const [metric, setMetric] = useState<AutomationRule["triggerMetric"]>("CPA");
  const [operator, setOperator] = useState<AutomationRule["operator"]>(">");
  const [threshold, setThreshold] = useState<number>(0);
  const [action, setAction] = useState<AutomationRule["action"]>("Pause Campaign");
  const [actionValue, setActionValue] = useState("");
  const [cooldown, setCooldown] = useState("24h");
  const [priority, setPriority] = useState<AutomationRule["priority"]>("Medium");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listAutomationRules(workspaceId)
      .then(data => {
        if (!cancelled) setRules(data.map(fromApiRule));
      })
      .catch(() => {
        if (!cancelled) setRules(DEFAULT_RULES);
      });
    return () => { cancelled = true; };
  }, [workspaceId]);

  function handleToggle(id: string) {
    setRules(prev =>
      prev.map(r => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    );
  }

  async function handleAddRule(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!name.trim()) return;

    if (!Number.isFinite(threshold) || threshold < THRESHOLD_MIN || threshold > THRESHOLD_MAX) {
      setFormError(`Threshold value must be between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}.`);
      return;
    }

    setSubmitting(true);
    try {
      const created = await api.createAutomationRule(workspaceId, {
        name,
        metric: METRIC_TO_API[metric],
        operator: OPERATOR_TO_API[operator],
        thresholdValue: threshold,
        action,
        actionParam: actionValue || undefined,
        cooldownMinutes: cooldownToMinutes(cooldown),
        priority: PRIORITY_TO_API[priority]
      });

      setRules(prev => [...prev, fromApiRule(created)]);
      // reset form
      setName("");
      setMetric("CPA");
      setOperator(">");
      setThreshold(0);
      setAction("Pause Campaign");
      setActionValue("");
      setCooldown("24h");
      setPriority("Medium");
      setShowAddForm(false);
    } catch {
      setFormError("Failed to create automation rule.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this rule?")) return;
    try {
      await api.deleteAutomationRule(id);
      setRules(prev => prev.filter(r => r.id !== id));
    } catch {
      setFormError("Failed to delete automation rule.");
    }
  }

  return (
    <div className="page-rules">
      <div className="page-header">
        <div>
          <h1>AI Automation Rules</h1>
          <p className="subtitle">Set up triggers to automatically manage budgets, pause campaigns, or duplicate high performers.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAddForm(!showAddForm)}>
          {showAddForm ? "Close Form" : "+ Create Rule"}
        </button>
      </div>

      {showAddForm && (
        <section className="card mb-4 creative-create-card">
          <h2>Create Optimization Rule</h2>
          <form onSubmit={handleAddRule} className="creative-form mt-3">
            <div className="flex-col">
              <label htmlFor="rule-name-input" className="font-weight-600 font-size-13 text-secondary block mb-1">Rule Name</label>
              <input
                id="rule-name-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Budget Cap for Low ROI"
                required
              />
            </div>

            <div className="form-row-3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px", marginTop: "12px" }}>
              <div className="flex-col">
                <label htmlFor="rule-metric-select" className="font-weight-600 font-size-13 text-secondary block mb-1">Trigger Metric</label>
                <select id="rule-metric-select" value={metric} onChange={(e) => setMetric(e.target.value as any)}>
                  <option value="CPA">CPA (Cost Per Acquisition)</option>
                  <option value="CTR">CTR (Click-Through Rate)</option>
                  <option value="ROAS">ROAS (Return on Ad Spend)</option>
                  <option value="Spend">Spend (Total budget spent)</option>
                </select>
              </div>

              <div className="flex-col">
                <label htmlFor="rule-operator-select" className="font-weight-600 font-size-13 text-secondary block mb-1">Condition</label>
                <select id="rule-operator-select" value={operator} onChange={(e) => setOperator(e.target.value as any)}>
                  <option value=">">Is Greater Than (&gt;)</option>
                  <option value="<">Is Less Than (&lt;)</option>
                  <option value="=">Equals (=)</option>
                </select>
              </div>

              <div className="flex-col">
                <label htmlFor="rule-threshold-input" className="font-weight-600 font-size-13 text-secondary block mb-1">Threshold Value</label>
                <input
                  id="rule-threshold-input"
                  type="number"
                  step="any"
                  min={THRESHOLD_MIN}
                  max={THRESHOLD_MAX}
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  required
                />
              </div>
            </div>

            <div className="form-row-3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px", marginTop: "12px" }}>
              <div className="flex-col">
                <label htmlFor="rule-action-select" className="font-weight-600 font-size-13 text-secondary block mb-1">Action Output</label>
                <select id="rule-action-select" value={action} onChange={(e) => setAction(e.target.value as any)}>
                  <option value="Pause Campaign">Pause Campaign</option>
                  <option value="Increase Budget">Scale Budget (+%)</option>
                  <option value="Duplicate Campaign">Duplicate Campaign</option>
                  <option value="Notify Team">Send Alert Notification</option>
                </select>
              </div>

              <div className="flex-col">
                <label htmlFor="rule-action-val-input" className="font-weight-600 font-size-13 text-secondary block mb-1">Action Parameter (e.g. 20%)</label>
                <input
                  id="rule-action-val-input"
                  type="text"
                  value={actionValue}
                  onChange={(e) => setActionValue(e.target.value)}
                  placeholder="e.g. 20% (optional)"
                />
              </div>

              <div className="flex-col">
                <label htmlFor="rule-cooldown-select" className="font-weight-600 font-size-13 text-secondary block mb-1">Cooldown Period</label>
                <select id="rule-cooldown-select" value={cooldown} onChange={(e) => setCooldown(e.target.value)}>
                  <option value="12h">12 Hours Cooldown</option>
                  <option value="24h">24 Hours Cooldown</option>
                  <option value="48h">48 Hours Cooldown</option>
                  <option value="7d">7 Days Cooldown</option>
                </select>
              </div>
            </div>

            <div className="flex-col mt-3">
              <label htmlFor="rule-priority-select" className="font-weight-600 font-size-13 text-secondary block mb-1">Rule Priority</label>
              <select id="rule-priority-select" value={priority} onChange={(e) => setPriority(e.target.value as any)}>
                <option value="Low">Low Priority</option>
                <option value="Medium">Medium Priority</option>
                <option value="High">High Priority</option>
              </select>
            </div>

            {formError && <p className="error mt-3">{formError}</p>}

            <button className="btn btn-primary mt-4" type="submit" disabled={submitting} aria-label="Save current automation rule details">
              {submitting ? "Saving..." : "Save Automation Rule"}
            </button>
          </form>
        </section>
      )}

      <Reveal>
        <div className="monitoring-grid">
          {rules.map((r) => (
            <div key={r.id} className="card rule-card">
              <div className="rule-card-header">
                <span className="rule-name">{r.name}</span>
                <span className="rule-meta-tag">{r.priority} Priority</span>
              </div>
              
              <div className="flex-col gap-2 mt-2 font-size-13" style={{ color: "#4b5563" }}>
                <div>
                  Trigger Condition: <strong style={{ color: "#111827" }}>{r.triggerMetric} {r.operator} {r.triggerMetric === "CPA" ? formatMoneyWhole(r.threshold, currency, { decimals: 0 }) : r.triggerMetric === "CTR" ? `${r.threshold}%` : r.threshold}</strong>
                </div>
                <div>
                  Action Executed: <strong style={{ color: "#7033f5" }}>{r.action} {r.actionValue ? `(${r.actionValue})` : ""}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: "4px" }}>
                  <span>Cooldown: <strong>{r.cooldown}</strong></span>
                  <span>State: <strong style={{ color: r.enabled ? "#10b981" : "#9ca3af" }}>{r.enabled ? "Active" : "Paused"}</strong></span>
                </div>
              </div>

              <div className="flex gap-2 mt-4">
                <button
                  className="btn btn-sm btn-secondary"
                  style={{ flex: 1 }}
                  onClick={() => handleToggle(r.id)}
                >
                  {r.enabled ? "⏸ Pause Rule" : "▶ Activate Rule"}
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => handleDelete(r.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </Reveal>
    </div>
  );
}
