import { Routes, Route, Navigate, NavLink, useLocation } from "react-router-dom";
import { usePageHeader } from "../../context/PageHeaderContext.js";
import AdPlatformConnectionTab from "./AdPlatformConnectionTab.js";
import SubscribeTab from "./SubscribeTab.js";
import YourProfileTab from "./YourProfileTab.js";

const TAB_LABELS: Record<string, string> = {
  "ad-platform-connection": "Ad Platform Connection",
  subscribe: "Subscribe",
  "your-profile": "Your profile"
};

export default function UserCenter({ businessId }: { businessId: string }) {
  const location = useLocation();
  const activeSegment = location.pathname.split("/").filter(Boolean).pop() ?? "ad-platform-connection";
  const breadcrumbLabel = TAB_LABELS[activeSegment] ?? "Ad Platform Connection";
  usePageHeader({ breadcrumb: ["User Center", breadcrumbLabel] });

  return (
    <div className="page-user-center">
      <nav className="admin-tabs-nav">
        <NavLink to="ad-platform-connection" className={({ isActive }) => `admin-tab-link ${isActive ? "active" : ""}`}>
          Ad Platform Connection
        </NavLink>
        <NavLink to="subscribe" className={({ isActive }) => `admin-tab-link ${isActive ? "active" : ""}`}>
          Subscribe
        </NavLink>
        <NavLink to="your-profile" className={({ isActive }) => `admin-tab-link ${isActive ? "active" : ""}`}>
          Your profile
        </NavLink>
      </nav>

      <Routes>
        <Route path="/" element={<Navigate to="ad-platform-connection" replace />} />
        <Route path="ad-platform-connection" element={<AdPlatformConnectionTab businessId={businessId} />} />
        <Route path="subscribe" element={<SubscribeTab businessId={businessId} />} />
        <Route path="your-profile" element={<YourProfileTab />} />
      </Routes>
    </div>
  );
}
