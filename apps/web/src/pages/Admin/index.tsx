import { currentWorkspaceId } from "../../lib/workspace.js";
import { useEffect, useState } from "react";
import { Routes, Route, Navigate, NavLink } from "react-router-dom";
import { api, Workspace, WorkspaceMember } from "../../api/client.js";

import WorkspaceTab from "./WorkspaceTab.js";
import MembersTab from "./MembersTab.js";
import RolesTab from "./RolesTab.js";
import AuditLogsTab from "./AuditLogsTab.js";
import DeveloperPortalTab from "./DeveloperPortalTab.js";
import MonitoringTab from "./MonitoringTab.js";

export default function Admin({ businessId }: { businessId: string }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const wsId = currentWorkspaceId();

  async function loadAdminData() {
    setLoading(true);
    setError(null);
    try {
      const [ws, mems] = await Promise.all([
        api.getWorkspace(wsId),
        api.listMembers(wsId)
      ]);
      setWorkspace(ws);
      setMembers(mems);
    } catch {
      setError("Failed to fetch admin settings. Access restricted.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAdminData();
  }, [businessId]);

  if (loading) {
    return (
      <div className="campaigns-loading">
        <p className="muted-text">Loading administration panel...</p>
        {[1, 2].map(i => <div key={i} className="campaign-row-skeleton" />)}
      </div>
    );
  }

  if (error || !workspace) {
    return <p className="error">{error || "Failed to load workspace settings."}</p>;
  }

  return (
    <div className="page-admin">
      <div className="page-header">
        <div>
          <h1>Workspace Control Center</h1>
          <p className="subtitle">Configure settings, manage roles &amp; RBAC permissions, monitor systems, and configure integrations.</p>
        </div>
      </div>

      {/* Sub tabs navigation */}
      <nav className="admin-tabs-nav">
        <NavLink to="workspace" className={({ isActive }) => `admin-tab-link ${isActive ? "active" : ""}`}>
          Workspace Profile
        </NavLink>
        <NavLink to="members" className={({ isActive }) => `admin-tab-link ${isActive ? "active" : ""}`}>
          Team Members
        </NavLink>
        <NavLink to="roles" className={({ isActive }) => `admin-tab-link ${isActive ? "active" : ""}`}>
          Roles &amp; RBAC
        </NavLink>
        <NavLink to="audit" className={({ isActive }) => `admin-tab-link ${isActive ? "active" : ""}`}>
          Audit Logs
        </NavLink>
        <NavLink to="developer" className={({ isActive }) => `admin-tab-link ${isActive ? "active" : ""}`}>
          Developer Portal
        </NavLink>
        <NavLink to="monitoring" className={({ isActive }) => `admin-tab-link ${isActive ? "active" : ""}`}>
          Monitoring
        </NavLink>
      </nav>

      {/* Nested routes routing */}
      <Routes>
        <Route path="/" element={<Navigate to="workspace" replace />} />
        <Route
          path="workspace"
          element={<WorkspaceTab workspace={workspace} onRefresh={loadAdminData} />}
        />
        <Route
          path="members"
          element={<MembersTab workspaceId={workspace.id} members={members} onRefresh={loadAdminData} />}
        />
        <Route path="roles" element={<RolesTab />} />
        <Route path="audit" element={<AuditLogsTab />} />
        <Route path="developer" element={<DeveloperPortalTab />} />
        <Route path="monitoring" element={<MonitoringTab />} />
      </Routes>
    </div>
  );
}
