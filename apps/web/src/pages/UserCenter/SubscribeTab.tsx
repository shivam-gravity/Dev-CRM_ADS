import { currentWorkspaceId } from "../../lib/workspace.js";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Workspace } from "../../api/client.js";

export default function SubscribeTab({ businessId }: { businessId: string }) {
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsId = currentWorkspaceId();

  useEffect(() => {
    api.getWorkspace(wsId).then(setWorkspace).catch(() => setError("Couldn't load your current plan."));
  }, [businessId]);

  const planLabel = workspace?.plan ? workspace.plan.charAt(0).toUpperCase() + workspace.plan.slice(1) : "Free";

  return (
    <div className="subscribe-tab">
      <div className="card">
        <h2>Current Plan</h2>
        {error && <p className="error">{error}</p>}
        <div className="header-profile-plan-badge subscribe-plan-badge">
          <span>{planLabel}</span>
          <span className="header-profile-plan-status">
            <span className="live-dot" /> {planLabel}
          </span>
        </div>
        <p className="muted-text mt-3">
          Manage payment methods, upgrade tiers, and view invoice history from the Billing page.
        </p>
        <button className="btn btn-primary mt-3" onClick={() => navigate("/billing")}>
          Manage Billing
        </button>
      </div>
    </div>
  );
}
