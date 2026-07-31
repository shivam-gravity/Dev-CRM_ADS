import { currentWorkspaceId } from "../lib/workspace.js";
import { useEffect, useRef, useState, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ClockIcon, GlobeIcon, BellIcon, UserIcon, CreditCardIcon, LinkIcon } from "./icons.js";
import { useAuth } from "../context/AuthContext.js";
import { api } from "../api/client.js";

// How often the bell re-polls the unread count. Cheap COUNT query; 30s keeps the badge
// live without a websocket while a user sits on a page.
const UNREAD_POLL_MS = 30_000;

// `rightSlot` lets a page inject a control (e.g. Ads Manager's "Manage Funds" widget) at
// the start of the right-hand cluster, ahead of the shared clock / language / bell / profile.
export default function PolluxaHeader({ breadcrumb, rightSlot }: { breadcrumb: string[]; rightSlot?: ReactNode }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const [unreadCount, setUnreadCount] = useState(0);

  // Real-time-ish unread badge: poll the notifications count on mount and on an interval,
  // instead of the previous hardcoded/decorative bell. Fails silent — a bell with no badge
  // is the correct fallback when the count call errors.
  useEffect(() => {
    const wsId = currentWorkspaceId();
    let cancelled = false;
    const refresh = () => api.unreadCount(wsId).then((r) => { if (!cancelled) setUnreadCount(r.count); }).catch(() => {});
    refresh();
    const timer = setInterval(refresh, UNREAD_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!profileOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [profileOpen]);

  const name = user?.name ?? "Guest";
  const initials = name.slice(0, 2).toUpperCase();

  function goTo(path: string) {
    setProfileOpen(false);
    navigate(path);
  }

  return (
    <header className="polluxa-header">
      <div className="polluxa-crumb">
        {breadcrumb.map((label, i) => (
          <span key={label} className={i === breadcrumb.length - 1 ? "polluxa-crumb-current" : undefined}>
            {i > 0 ? `› ${label}` : label}
          </span>
        ))}
      </div>
      <div className="polluxa-header-right">
        {rightSlot}
        <div className="header-meta-item">
          <ClockIcon />
          <span>UTC+5.5</span>
        </div>
        <div className="header-meta-item">
          <GlobeIcon />
          <span>English</span>
        </div>
        <button type="button" className="header-bell" onClick={() => navigate("/notifications")} aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}>
          <BellIcon />
          {unreadCount > 0 && <span className="header-bell-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>}
        </button>
        <div className="header-profile-dropdown-wrap" ref={profileRef}>
          <div className="header-profile-dropdown" onClick={() => setProfileOpen((o) => !o)}>
            <div className="profile-avatar">{initials}</div>
            <div className="profile-info">
              <span className="profile-name">{name}</span>
              <span className="profile-username">{user?.email ?? name}</span>
            </div>
            <span style={{ fontSize: "10px", color: "#9ca3af", marginLeft: "4px" }}>▼</span>
          </div>
          {profileOpen && (
            <div className="header-profile-menu">
              <div className="header-profile-menu-section-label">Subscription</div>
              <button type="button" className="header-profile-plan-badge" onClick={() => goTo("/profile/subscribe")}>
                <span>Free</span>
                <span className="header-profile-plan-status">
                  <span className="live-dot" /> Free
                </span>
              </button>

              <div className="header-profile-menu-section-label">Manage My CRM Ads</div>
              <button type="button" className="header-profile-menu-item" onClick={() => goTo("/profile/your-profile")}>
                <UserIcon /> User Profile
              </button>
              <button type="button" className="header-profile-menu-item" onClick={() => goTo("/profile/subscribe")}>
                <CreditCardIcon /> Subscription
              </button>

              <div className="header-profile-menu-divider" />
              <div className="header-profile-menu-section-label">Setting</div>
              <button type="button" className="header-profile-menu-item" onClick={() => goTo("/profile/ad-platform-connection")}>
                <LinkIcon /> Advertising Accounts
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
