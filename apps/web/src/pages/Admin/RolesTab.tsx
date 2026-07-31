import { currentWorkspaceId } from "../../lib/workspace.js";
import { useEffect, useState } from "react";
import { api, RbacMatrix } from "../../api/client.js";

// Permission keys match rbacService.ts's DEFAULT_MATRIX exactly — this is the shape
// GET/PUT /api/workspaces/:id/rbac-matrix actually reads and writes.
const PERMISSIONS = [
  { key: "campaigns", label: "Create & Launch Campaigns" },
  { key: "creatives", label: "Manage Creatives" },
  { key: "billing", label: "Billing Management" },
  { key: "members", label: "Manage Team Members" },
  { key: "settings", label: "Workspace Settings" }
] as const;

// The only 4 roles that actually exist — WorkspaceMember.role is "owner" | "admin" |
// "member" | "viewer" (workspaceService.ts), same set MembersTab.tsx's invite picker
// offers. A richer role set was drawn here previously but never existed on the backend,
// which crashed this page the moment a real (mismatched) matrix loaded from the API.
const ROLES = ["owner", "admin", "member", "viewer"] as const;

const ROLE_LABELS: Record<typeof ROLES[number], string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

// Mirrors rbacService.ts's DEFAULT_MATRIX — only used as a placeholder while the real
// matrix is loading, or if the load fails.
const DEFAULT_MATRIX: Record<typeof ROLES[number], Record<string, boolean>> = {
  owner: { billing: true, campaigns: true, creatives: true, members: true, settings: true },
  admin: { billing: false, campaigns: true, creatives: true, members: true, settings: true },
  member: { billing: false, campaigns: true, creatives: true, members: false, settings: false },
  viewer: { billing: false, campaigns: false, creatives: false, members: false, settings: false },
};

const wsId = currentWorkspaceId();

export default function RolesTab() {
  const [matrix, setMatrix] = useState<RbacMatrix>(DEFAULT_MATRIX);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modified, setModified] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getRbacMatrix(wsId)
      .then(m => {
        if (!cancelled) setMatrix(m);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load RBAC permissions matrix.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  function handleToggle(role: typeof ROLES[number], permissionKey: string) {
    if (role === "owner") return; // Owner permissions are immutable
    setMatrix(prev => ({
      ...prev,
      [role]: {
        ...prev[role],
        [permissionKey]: !prev[role]?.[permissionKey]
      }
    }));
    setModified(true);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.setRbacMatrix(wsId, matrix);
      setMatrix(saved);
      setModified(false);
      alert("RBAC Permissions Matrix updated successfully.");
    } catch (err) {
      setError("Failed to save RBAC permissions matrix.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <div className="flex justify-between items-center mb-2">
        <div>
          <h2>Role-Based Access Control (RBAC)</h2>
          <p className="muted-text mt-1">Configure feature permission grids for standard team member roles.</p>
        </div>
        {modified && (
          <button className="btn btn-sm btn-primary" onClick={handleSave} disabled={saving || loading}>
            {saving ? "Saving Changes..." : "Save Matrix Modifications"}
          </button>
        )}
      </div>

      {error && <p className="error mt-2">{error}</p>}

      <div className="table-wrap mt-4" style={{ overflowX: "auto" }}>
        <table className="rbac-matrix-table">
          <thead>
            <tr>
              <th>Feature Permission</th>
              {ROLES.map(role => (
                <th key={role}>{ROLE_LABELS[role]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.map(perm => (
              <tr key={perm.key}>
                <td>{perm.label}</td>
                {ROLES.map(role => {
                  // Defensive read, not a bare index: a role/permission the API doesn't
                  // (yet) have an entry for reads as unchecked instead of crashing the
                  // whole page — this exact shape mismatch is what crashed this tab before.
                  const isChecked = matrix[role]?.[perm.key] ?? false;
                  return (
                    <td key={role}>
                      <input
                        type="checkbox"
                        className="rbac-checkbox"
                        checked={isChecked}
                        disabled={role === "owner"}
                        onChange={() => handleToggle(role, perm.key)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
