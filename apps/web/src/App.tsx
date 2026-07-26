import { NavLink, Route, Routes, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { MascotIcon, SearchIcon } from "./components/icons.js";
import { AuthProvider, useAuth } from "./context/AuthContext.js";
import { PageHeaderProvider, usePageHeaderConfig } from "./context/PageHeaderContext.js";
import PolluxaHeader from "./components/PolluxaHeader.js";
import { RealtimeProvider } from "./providers/RealtimeProvider.js";

// Page imports
import Onboarding from "./pages/Onboarding.js";
import Dashboard from "./pages/Dashboard.js";
import CampaignDetail from "./pages/CampaignDetail.js";
import Campaigns from "./pages/Campaigns.js";
import NewCampaign from "./pages/NewCampaign.js";
import CampaignBuilder from "./pages/CampaignBuilder.js";
import Analytics from "./pages/Analytics.js";
import Audiences from "./pages/Audiences.js";
import Creatives from "./pages/Creatives.js";
import Billing from "./pages/Billing.js";
import Privacy from "./pages/Privacy.js";
import Terms from "./pages/Terms.js";
import Features from "./pages/Features.js";
import Pricing from "./pages/Pricing.js";
import Resources from "./pages/Resources.js";
import AutoCreative from "./pages/AutoCreative.js";
import Compare from "./pages/Compare.js";
import AboutUs from "./pages/AboutUs.js";
import Contact from "./pages/Contact.js";
import Blog from "./pages/Blog.js";

// New Pages Imports
import CampaignGenerator from "./pages/CampaignGenerator.js";
import CreativeStudio from "./pages/CreativeStudio.js";
import AudienceBuilder from "./pages/AudienceBuilder.js";
import AdsManager from "./pages/AdsManager.js";
import Drafts from "./pages/Drafts.js";
import AIInsights from "./pages/AIInsights.js";
import AssetLibrary from "./pages/AssetLibrary.js";
import Notifications from "./pages/Notifications.js";
import HelpCenter from "./pages/HelpCenter.js";
import Admin from "./pages/Admin/index.js";
import AutomationRules from "./pages/AutomationRules.js";
import MediaPlan from "./pages/MediaPlan.js";
import OptimizeGoal from "./pages/OptimizeGoal.js";
import BrandProfile from "./pages/BrandProfile.js";
import Products from "./pages/Products.js";
import NotFound from "./pages/NotFound.js";
import UserCenter from "./pages/UserCenter/index.js";
import Landing from "./pages/Landing.js";
import Login from "./pages/Login.js";
import Register from "./pages/Register.js";
import CrmRedirect from "./pages/CrmRedirect.js";
import { CopilotProvider, useCopilot } from "./providers/CopilotProvider.js";
import CopilotDrawer from "./components/Copilot/Drawer.js";
import ErrorBoundary from "./components/ErrorBoundary.js";
import HelpWidget from "./components/HelpWidget.js";
import RouteProgressBar from "./components/RouteProgressBar.js";
import FullPageLoader from "./components/FullPageLoader.js";

const MARKETING_ROUTES: Record<string, JSX.Element> = {
  "/features": <Features />,
  "/pricing": <Pricing />,
  "/resources": <Resources />,
  "/auto-creative": <AutoCreative />,
  "/compare": <Compare />,
  "/about-us": <AboutUs />,
  "/contact": <Contact />,
  "/blog": <Blog />,
  "/privacy": <Privacy />,
  "/privacy-policy": <Privacy />,
  "/terms": <Terms />,
};

// Default breadcrumb per route, mirroring the sidebar labels. Pages with a *dynamic*
// breadcrumb (a campaign name, the active profile tab, …) override this at runtime via
// usePageHeader(); everything else is derived here so the shell header is correct without
// the page having to say anything.
const ROUTE_BREADCRUMBS: { match: (path: string) => boolean; crumb: string[] }[] = [
  { match: (p) => p === "/dashboard", crumb: ["Home"] },
  { match: (p) => p === "/media-plan", crumb: ["Chat Strategist"] },
  { match: (p) => p === "/campaigns/new", crumb: ["New Campaign"] },
  { match: (p) => p === "/campaigns/generator", crumb: ["Campaign Generator"] },
  { match: (p) => p === "/campaigns", crumb: ["Campaigns"] },
  { match: (p) => p === "/manager", crumb: ["AI Optimize", "Ads Manager"] },
  { match: (p) => p === "/drafts", crumb: ["AI Optimize", "Draft & AI Recs"] },
  { match: (p) => p === "/studio", crumb: ["Creative Hub", "AI Generate"] },
  { match: (p) => p === "/assets", crumb: ["Creative Hub", "Creative Library"] },
  { match: (p) => p === "/creatives", crumb: ["Creative Hub", "Creatives"] },
  { match: (p) => p === "/analytics", crumb: ["Analytics", "Ad Insights"] },
  { match: (p) => p === "/insights", crumb: ["Analytics", "AI Analysis"] },
  { match: (p) => p === "/audiences", crumb: ["Audiences"] },
  { match: (p) => p === "/goal", crumb: ["Brand Center", "Optimize Goal"] },
  { match: (p) => p === "/brand", crumb: ["Brand Center", "Brand Profile"] },
  { match: (p) => p === "/products", crumb: ["Brand Center", "Products"] },
  { match: (p) => p === "/billing", crumb: ["Billing"] },
  { match: (p) => p === "/notifications", crumb: ["Notifications"] },
  { match: (p) => p === "/rules", crumb: ["Automation Rules"] },
  { match: (p) => p === "/help", crumb: ["Help Center"] },
  { match: (p) => p.startsWith("/admin"), crumb: ["Admin"] },
];

function defaultBreadcrumb(pathname: string): string[] {
  return ROUTE_BREADCRUMBS.find((r) => r.match(pathname))?.crumb ?? ["Home"];
}

// The single, shell-level header. Renders on every authenticated route so the header can
// never again go missing (or ship a broken hand-rolled copy) on a per-page basis. Uses the
// page's pushed breadcrumb/right-slot when present, otherwise the route default.
function ShellHeader() {
  const location = useLocation();
  const { config } = usePageHeaderConfig();
  const breadcrumb = config.breadcrumb ?? defaultBreadcrumb(location.pathname);
  return <PolluxaHeader breadcrumb={breadcrumb} rightSlot={config.rightSlot} />;
}

function AuthenticatedApp() {
  const { businessId } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [brandQuery, setBrandQuery] = useState("");
  const [brands, setBrands] = useState([{ id: "default", name: "Default Brand" }]);
  const [selectedBrandId, setSelectedBrandId] = useState("default");
  const brandMenuRef = useRef<HTMLDivElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!brandMenuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (brandMenuRef.current && !brandMenuRef.current.contains(e.target as Node)) {
        setBrandMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [brandMenuOpen]);

  useEffect(() => {
    if (!helpOpen) return;
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (helpPanelRef.current && !helpPanelRef.current.contains(target) && !(e.target as HTMLElement).closest(".help-widget-trigger")) {
        setHelpOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [helpOpen]);

  const selectedBrand = brands.find((b) => b.id === selectedBrandId) ?? brands[0];
  const filteredBrands = brands.filter((b) => b.name.toLowerCase().includes(brandQuery.toLowerCase()));

  function handleCreateBrand() {
    setBrandMenuOpen(false);
    setBrandQuery("");
    navigate("/brand");
  }

  return (
    <PageHeaderProvider>
    <div className="app-shell-sidebar">
      <RouteProgressBar />
      {/* Sidebar */}
      <aside className={`sidebar polluxa-sidebar ${sidebarOpen ? "sidebar-open" : ""} ${brandMenuOpen ? "sidebar-pinned" : ""}`}>
        <div className="sidebar-brand polluxa-brand">
          <NavLink to="/dashboard" className="brand-lockup-polluxa" onClick={() => setSidebarOpen(false)}>
            <span className="brand-logo-badge"><img src="/polluxa-logo.svg" alt="Polluxa" /></span>
            <span className="brand-text-polluxa">Polluxa Ads</span>
          </NavLink>
        </div>

        <div className="workspace-selector-wrap" ref={brandMenuRef}>
          <div className="workspace-selector" onClick={() => setBrandMenuOpen((o) => !o)}>
            <div className="workspace-avatar">{selectedBrand.name.charAt(0).toUpperCase()}</div>
            <div className="workspace-info">
              <span className="workspace-title">{selectedBrand.name}</span>
              <span className="workspace-sub">Workspace</span>
            </div>
            <span className={`workspace-chevron ${brandMenuOpen ? "workspace-chevron-open" : ""}`}>▼</span>
          </div>

          {brandMenuOpen && (
            <div className="workspace-dropdown">
              <div className="workspace-dropdown-search">
                <SearchIcon className="workspace-dropdown-search-icon" />
                <input
                  type="text"
                  placeholder="Search brands..."
                  value={brandQuery}
                  onChange={(e) => setBrandQuery(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="workspace-dropdown-list">
                {filteredBrands.map((b) => (
                  <div
                    key={b.id}
                    className="workspace-dropdown-item"
                    onClick={() => {
                      setSelectedBrandId(b.id);
                      setBrandMenuOpen(false);
                      setBrandQuery("");
                    }}
                  >
                    <span>{b.name}</span>
                    {b.id === selectedBrandId && <span className="workspace-dropdown-check">✓</span>}
                  </div>
                ))}
                {filteredBrands.length === 0 && (
                  <div className="workspace-dropdown-empty">No brands found</div>
                )}
              </div>

              <button type="button" className="workspace-dropdown-create" onClick={handleCreateBrand}>
                <span className="workspace-dropdown-create-icon">+</span> Create new brand
              </button>
            </div>
          )}
        </div>

        {businessId && (
          <>
          <nav className="sidebar-nav polluxa-nav" style={{ overflowY: "auto", paddingBottom: "24px" }}>
            <NavLink to="/dashboard" className={({ isActive }) => `sidebar-link polluxa-link ${isActive ? "active" : ""}`} onClick={() => setSidebarOpen(false)}>
              <span className="sidebar-link-inner">
                <svg className="sidebar-link-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>
                <span className="sidebar-link-label">Home</span>
              </span>
            </NavLink>
            <NavLink to="/media-plan" className={({ isActive }) => `sidebar-link polluxa-link ${isActive ? "active" : ""}`} onClick={() => setSidebarOpen(false)}>
              <span className="sidebar-link-inner">
                <svg className="sidebar-link-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                <span className="sidebar-link-label">Media Plan</span>
              </span>
            </NavLink>
            <NavLink to="/campaigns/new" className={({ isActive }) => `sidebar-link polluxa-link ${isActive ? "active" : ""}`} onClick={() => setSidebarOpen(false)}>
              <span className="sidebar-link-inner">
                <svg className="sidebar-link-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" /></svg>
                <span className="sidebar-link-label">New Campaign</span>
              </span>
            </NavLink>
            <NavLink to="/campaigns/generator" className={({ isActive }) => `sidebar-link polluxa-link ${isActive ? "active" : ""}`} onClick={() => setSidebarOpen(false)}>
              <span className="sidebar-link-inner">
                <svg className="sidebar-link-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>
                <span className="sidebar-link-label">Campaign Generator</span>
              </span>
            </NavLink>

            <div className="sidebar-nav-group-label polluxa-label">AI OPTIMIZE</div>
            <NavLink to="/manager" className={({ isActive }) => `sidebar-link polluxa-link ${isActive ? "active" : ""}`} onClick={() => setSidebarOpen(false)}>
              <span className="sidebar-link-inner">
                <svg className="sidebar-link-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" /></svg>
                <span className="sidebar-link-label">Ads Manager</span>
              </span>
            </NavLink>
            <NavLink to="/drafts" className={({ isActive }) => `sidebar-link polluxa-link ${isActive ? "active" : ""}`} onClick={() => setSidebarOpen(false)}>
              <span className="sidebar-link-inner">
                <svg className="sidebar-link-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
                <span className="sidebar-link-label">Draft & AI Recs</span>
              </span>
            </NavLink>
            <div className="sidebar-nav-group-label polluxa-label">CREATIVE HUB</div>
            <NavLink to="/studio" className={({ isActive }) => `sidebar-link polluxa-link ${isActive ? "active" : ""}`} onClick={() => setSidebarOpen(false)}>
              <span className="sidebar-link-inner">
                <svg className="sidebar-link-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /><path d="M12 8l-2 4 2 4 2-4-2-4z" /></svg>
                <span className="sidebar-link-label">AI Generate</span>
              </span>
            </NavLink>
            <NavLink to="/assets" className={({ isActive }) => `sidebar-link polluxa-link ${isActive ? "active" : ""}`} onClick={() => setSidebarOpen(false)}>
              <span className="sidebar-link-inner">
                <svg className="sidebar-link-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
                <span className="sidebar-link-label">Creative Library</span>
              </span>
            </NavLink>

            <div className="sidebar-nav-group-label polluxa-label">ANALYTICS</div>
            <NavLink to="/analytics" className={({ isActive }) => `sidebar-link polluxa-link ${isActive ? "active" : ""}`} onClick={() => setSidebarOpen(false)}>
              <span className="sidebar-link-inner">
                <svg className="sidebar-link-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
                <span className="sidebar-link-label">Ad Insights</span>
              </span>
            </NavLink>
            <NavLink to="/insights" className={({ isActive }) => `sidebar-link polluxa-link ${isActive ? "active" : ""}`} onClick={() => setSidebarOpen(false)}>
              <span className="sidebar-link-inner">
                <svg className="sidebar-link-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>
                <span className="sidebar-link-label">AI Analysis</span>
              </span>
            </NavLink>

            <div className="sidebar-nav-group-label polluxa-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
              <span>BRAND CENTER</span>
              <span style={{ fontSize: '10px' }}>▼</span>
            </div>
            <NavLink to="/goal" className={({ isActive }) => `sidebar-link polluxa-link ${isActive ? "active" : ""}`} onClick={() => setSidebarOpen(false)}>
              <span className="sidebar-link-inner">
                <svg className="sidebar-link-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></svg>
                <span className="sidebar-link-label">Optimize Goal</span>
              </span>
            </NavLink>
            <NavLink to="/brand" className={({ isActive }) => `sidebar-link polluxa-link ${isActive ? "active" : ""}`} onClick={() => setSidebarOpen(false)}>
              <span className="sidebar-link-inner">
                <svg className="sidebar-link-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h12l3 5-9 13L3 8Z" /><path d="M3 8h18M9 3l3 5 3-5M12 8l-2 13M12 8l2 13" /></svg>
                <span className="sidebar-link-label">Brand Profile</span>
              </span>
            </NavLink>
            <NavLink to="/products" className={({ isActive }) => `sidebar-link polluxa-link ${isActive ? "active" : ""}`} onClick={() => setSidebarOpen(false)}>
              <span className="sidebar-link-inner">
                <svg className="sidebar-link-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></svg>
                <span className="sidebar-link-label">Products</span>
              </span>
            </NavLink>

          </nav>
          <div className="sidebar-footer polluxa-footer">
            <button
              type="button"
              className={`sidebar-link polluxa-link help-widget-trigger ${helpOpen ? "active" : ""}`}
              onClick={() => setHelpOpen((o) => !o)}
            >
              <span className="sidebar-link-inner">
                <svg className="sidebar-link-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" /></svg>
                <span className="sidebar-link-label">Help Center</span>
              </span>
            </button>
            {helpOpen && <HelpWidget onClose={() => setHelpOpen(false)} panelRef={helpPanelRef} />}
          </div>
          </>
        )}
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Main */}
      <div className="sidebar-main polluxa-main">
        {/* Mobile topbar */}
        <header className="mobile-topbar">
          <button
            className="mobile-menu-btn"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Toggle menu"
          >
            ☰
          </button>
          <NavLink to="/" className="brand brand-lockup">
            <MascotIcon className="mascot mascot-sm" />
            <span className="brand-text">CRM Ads</span>
          </NavLink>
        </header>

        <main className="sidebar-content polluxa-content">
          {/* One header for every route. Pages override the breadcrumb / right-slot via
              usePageHeader(); otherwise it's derived from the path (defaultBreadcrumb). */}
          <ShellHeader />
          {/* businessId is guaranteed non-null here — RequireAuth (below) already redirects
              to /get-started before AuthenticatedApp ever mounts without one. */}
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard businessId={businessId!} />} />
            <Route path="/campaigns" element={<Campaigns businessId={businessId!} />} />
            <Route path="/campaigns/new" element={<NewCampaign />} />
            <Route path="/campaigns/:campaignId/builder" element={<CampaignBuilder />} />
            <Route path="/campaigns/:campaignId" element={<CampaignDetail />} />
            <Route path="/analytics" element={<Analytics businessId={businessId!} />} />
            <Route path="/audiences" element={<AudienceBuilder businessId={businessId!} />} />
            <Route path="/creatives" element={<Creatives businessId={businessId!} />} />
            <Route path="/billing" element={<Billing businessId={businessId!} />} />

            {/* New Routes */}
            <Route path="/campaigns/generator" element={<CampaignGenerator businessId={businessId!} />} />
            <Route path="/studio" element={<CreativeStudio businessId={businessId!} />} />
            <Route path="/manager" element={<AdsManager businessId={businessId!} />} />
            <Route path="/drafts" element={<Drafts businessId={businessId!} />} />
            <Route path="/insights" element={<AIInsights businessId={businessId!} />} />
            <Route path="/assets" element={<AssetLibrary businessId={businessId!} />} />
            <Route path="/integrations" element={<Navigate to="/profile/ad-platform-connection" replace />} />
            <Route path="/profile/*" element={<UserCenter businessId={businessId!} />} />
            <Route path="/notifications" element={<Notifications businessId={businessId!} />} />
            <Route path="/help" element={<HelpCenter />} />
            <Route path="/admin/*" element={<Admin businessId={businessId!} />} />
            <Route path="/rules" element={<AutomationRules businessId={businessId!} />} />
            <Route path="/media-plan" element={<MediaPlan businessId={businessId!} />} />
            <Route path="/goal" element={<OptimizeGoal />} />
            <Route path="/brand" element={<BrandProfile />} />
            <Route path="/products" element={<Products />} />
            {/* Any unmatched path (including the old /login, /signup — there's no separate
                "logged out" state to send them to anymore) gets a real 404 rather than a
                silent redirect, so a stale/mistyped link doesn't look like a normal visit. */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>

      {/* Global AI Copilot Drawer Overlay */}
      <CopilotDrawer />

      {/* Global AI Copilot Floating Chat Trigger */}
      <CopilotFab />
    </div>
    </PageHeaderProvider>
  );
}

function CopilotFab() {
  const { openCopilot, isOpen } = useCopilot();
  if (isOpen) return null;
  return (
    <div className="chat-fab" onClick={openCopilot} title="Open AI Copilot">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </div>
  );
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const { isLoading, isAuthenticated, businessId } = useAuth();
  if (isLoading) return <FullPageLoader />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!businessId) return <Navigate to="/get-started" replace />;
  return children;
}

function RedirectIfAuthenticated({ children }: { children: JSX.Element }) {
  const { isLoading, isAuthenticated } = useAuth();
  if (isLoading) return <FullPageLoader />;
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;
  return children;
}

function OnboardingWrapper() {
  const { isLoading, businessId, setBusinessId } = useAuth();
  if (isLoading) return <FullPageLoader />;
  if (businessId) return <Navigate to="/dashboard" replace />;
  return <Onboarding onOnboarded={setBusinessId} />;
}

export default function App() {
  const location = useLocation();

  const marketingPage = MARKETING_ROUTES[location.pathname];
  if (marketingPage) {
    return marketingPage;
  }

  return (
    <ErrorBoundary>
      <AuthProvider>
        <RealtimeProvider>
          <CopilotProvider>
            <Routes>
              <Route path="/" element={<RedirectIfAuthenticated><Landing /></RedirectIfAuthenticated>} />
              <Route path="/login" element={<RedirectIfAuthenticated><Login /></RedirectIfAuthenticated>} />
              <Route path="/register" element={<RedirectIfAuthenticated><Register /></RedirectIfAuthenticated>} />
              <Route path="/auth/crm-callback" element={<CrmRedirect />} />
              <Route path="/get-started" element={<OnboardingWrapper />} />
              <Route path="/*" element={<RequireAuth><AuthenticatedApp /></RequireAuth>} />
            </Routes>
          </CopilotProvider>
        </RealtimeProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
