import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { api, User, Workspace, getAccessToken, setTokens, clearTokens } from "../api/client.js";

const DEMO_WORKSPACE_ID = "demo-workspace";
const DEMO_BUSINESS_ID = "demo-business";
const IS_DEV = import.meta.env.DEV;

interface AuthState {
  user: User | null;
  workspace: Workspace | null;
  workspaceId: string | null;
  businessId: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isCrmUser: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  loginWithCrmToken: (token: string) => Promise<void>;
  logout: () => void;
  setBusinessId: (id: string) => void;
  setWorkspace: (ws: Workspace) => void;
  refreshWorkspace: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspaceState] = useState<Workspace | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(localStorage.getItem("polluxa_workspace_id"));
  const [businessId, setBusinessIdState] = useState<string | null>(localStorage.getItem("businessId"));
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCrmUser, setIsCrmUser] = useState(false);

  function setBusinessId(id: string) {
    setBusinessIdState(id);
    localStorage.setItem("businessId", id);
  }

  function setWorkspace(ws: Workspace) {
    setWorkspaceState(ws);
    setWorkspaceId(ws.id);
    localStorage.setItem("polluxa_workspace_id", ws.id);
  }

  async function refreshWorkspace() {
    if (!workspaceId) return;
    try {
      const ws = await api.getWorkspace(workspaceId);
      setWorkspaceState(ws);
    } catch { /* non-fatal */ }
  }

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    setTokens(result.token, result.refreshToken);
    setUser(result.user);
    setIsAuthenticated(true);
    setIsCrmUser(false);
    if (result.workspaceId) {
      setWorkspaceId(result.workspaceId);
      localStorage.setItem("polluxa_workspace_id", result.workspaceId);
      const ws = await api.getWorkspace(result.workspaceId).catch(() => null);
      if (ws) setWorkspaceState(ws);
    }
    // Resolve the user's business so a returning user with an existing business lands on
    // /dashboard instead of being bounced to /get-started (RequireAuth redirects when
    // businessId is null). Prefer the id the login response now carries; otherwise fall back to
    // listing the workspace's businesses. Absent one, businessId stays null and onboarding runs.
    const resolvedBusinessId = result.businessId
      ?? (result.workspaceId ? (await api.listBusinesses(result.workspaceId).catch(() => []))[0]?.id : undefined);
    if (resolvedBusinessId) setBusinessId(resolvedBusinessId);
  }, []);

  const register = useCallback(async (name: string, email: string, password: string) => {
    const result = await api.register(name, email, password);
    setTokens(result.token, result.refreshToken);
    setUser(result.user);
    setIsAuthenticated(true);
    setIsCrmUser(false);
    if (result.workspaceId) {
      setWorkspaceId(result.workspaceId);
      localStorage.setItem("polluxa_workspace_id", result.workspaceId);
    }
  }, []);

  const loginWithCrmToken = useCallback(async (token: string) => {
    const result = await api.crmLogin(token);
    setTokens(result.accessToken, result.refreshToken);
    setUser(result.user);
    setIsAuthenticated(true);
    setIsCrmUser(true);
    setWorkspaceId(result.workspaceId);
    setBusinessIdState(result.businessId);
    localStorage.setItem("polluxa_workspace_id", result.workspaceId);
    localStorage.setItem("businessId", result.businessId);
    const ws = await api.getWorkspace(result.workspaceId).catch(() => null);
    if (ws) setWorkspaceState(ws);
  }, []);

  const logout = useCallback(() => {
    api.logout().catch(() => {});
    clearTokens();
    setUser(null);
    setWorkspaceState(null);
    setWorkspaceId(null);
    setBusinessIdState(null);
    setIsAuthenticated(false);
    setIsCrmUser(false);
    localStorage.removeItem("polluxa_workspace_id");
    localStorage.removeItem("businessId");
    window.location.href = "/login";
  }, []);

  useEffect(() => {
    const token = getAccessToken();

    if (!token && IS_DEV) {
      if (!localStorage.getItem("polluxa_workspace_id")) {
        localStorage.setItem("polluxa_workspace_id", DEMO_WORKSPACE_ID);
        setWorkspaceId(DEMO_WORKSPACE_ID);
      }
      if (!localStorage.getItem("businessId")) {
        localStorage.setItem("businessId", DEMO_BUSINESS_ID);
        setBusinessIdState(DEMO_BUSINESS_ID);
      }
      api.me()
        .then((u) => {
          setUser(u);
          setIsAuthenticated(true);
          const wsId = localStorage.getItem("polluxa_workspace_id") ?? DEMO_WORKSPACE_ID;
          return api.getWorkspace(wsId).then(setWorkspaceState).catch(() => {});
        })
        .catch(() => {})
        .finally(() => setIsLoading(false));
      return;
    }

    if (!token) {
      setIsLoading(false);
      return;
    }

    api.me()
      .then(async (u) => {
        setUser(u);
        setIsAuthenticated(true);
        const wsId = localStorage.getItem("polluxa_workspace_id");
        if (wsId) {
          await api.getWorkspace(wsId).then(setWorkspaceState).catch(() => {});
          // On a hard reload with a valid token but no cached businessId (e.g. a production user
          // who never went through onboarding on this browser), resolve the business from the
          // workspace so RequireAuth doesn't bounce them to /get-started. No-op if one's cached.
          if (!localStorage.getItem("businessId")) {
            const biz = (await api.listBusinesses(wsId).catch(() => []))[0];
            if (biz) setBusinessId(biz.id);
          }
        }
      })
      .catch(() => {
        clearTokens();
        setIsAuthenticated(false);
      })
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      workspace,
      workspaceId,
      businessId,
      isLoading,
      isAuthenticated,
      isCrmUser,
      login,
      register,
      loginWithCrmToken,
      logout,
      setBusinessId,
      setWorkspace,
      refreshWorkspace,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
