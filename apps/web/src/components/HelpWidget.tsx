import { currentWorkspaceId } from "../lib/workspace.js";
import { useState } from "react";
import type { RefObject } from "react";
import { CloseIcon, SearchIcon, ChevronRightIcon, InboxIcon, ArrowLeftIcon, ClockIcon } from "./icons.js";
import { api } from "../api/client.js";

const ARTICLES = [
  "Getting Started with CRM Ads — Launch Your First Campaign in 3 Simple Steps",
  "How to Use CRM Ads Drafts & Recommendations",
  "How to Change Your CRM Ads Account Password"
];

const COLLECTIONS = [
  { title: "Getting Started", desc: "Set up essentials before launching your first ad.", count: 10 },
  { title: "AI Creatives", desc: "Generate ad copy, images, and videos using AI.", count: 2 },
  { title: "Troubleshooting & Support", desc: "Troubleshooting common issues and questions.", count: 6 },
  { title: "Campaigns & Optimization", desc: "Manage budgets, targeting, and automated bidding.", count: 8 }
];

type Tab = "home" | "messages" | "help";

function HomeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function MessagesIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <line x1="7" y1="9" x2="17" y2="9" />
      <line x1="7" y1="13" x2="13" y2="13" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}

function SendArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="6 11 12 5 18 11" />
    </svg>
  );
}

function HelpTabIcon({ active }: { active: boolean }) {
  if (active) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="#7033f5" stroke="none">
        <circle cx="12" cy="12" r="12" />
        <path d="M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.7-2.6 2.6-2.6 2.6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        <circle cx="12" cy="16.8" r="0.9" fill="#fff" />
      </svg>
    );
  }
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
    </svg>
  );
}

export default function HelpWidget({ onClose, panelRef }: { onClose: () => void; panelRef: RefObject<HTMLDivElement> }) {
  const [activeTab, setActiveTab] = useState<Tab>("home");
  const [searchQuery, setSearchQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const [composeEmail, setComposeEmail] = useState("");
  const [messageText, setMessageText] = useState("");
  const [sending, setSending] = useState(false);
  const [messageSent, setMessageSent] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const query = searchQuery.trim().toLowerCase();
  const filteredArticles = query ? ARTICLES.filter((a) => a.toLowerCase().includes(query)) : ARTICLES;
  const filteredCollections = query
    ? COLLECTIONS.filter((c) => c.title.toLowerCase().includes(query) || c.desc.toLowerCase().includes(query))
    : COLLECTIONS;

  function handleTabChange(tab: Tab) {
    setActiveTab(tab);
    setSearchQuery("");
  }

  async function handleSendMessage() {
    if (!messageText.trim() || sending) return;
    const workspaceId = currentWorkspaceId();
    setSending(true);
    setSendError(null);
    try {
      await api.createSupportTicket(workspaceId, { subject: "Chat message", message: messageText });
      setComposing(false);
      setMessageSent(true);
      setMessageText("");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send message.");
    } finally {
      setSending(false);
    }
  }

  if (composing) {
    return (
      <div className="help-widget" role="dialog" aria-label="New conversation" ref={panelRef}>
        <div className="help-widget-compose-header">
          <button className="help-widget-back" onClick={() => setComposing(false)} aria-label="Back">
            <ArrowLeftIcon />
          </button>
          <div className="help-widget-compose-brand">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M12 2C12 2 13 8 18 12C13 16 12 22 12 22C12 22 11 16 6 12C11 8 12 2 12 2Z" fill="#7033f5" />
            </svg>
            <div className="help-widget-compose-brand-text">
              <strong>CRM Ads</strong>
              <span className="help-widget-compose-reply-time">
                <ClockIcon /> A few hours
              </span>
            </div>
          </div>
          <div className="help-widget-compose-header-actions">
            <button className="help-widget-close" aria-label="More options">
              <MoreIcon />
            </button>
            <button className="help-widget-close" onClick={onClose} aria-label="Close help">
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="help-widget-compose-body">
          <p className="help-widget-compose-prompt">Ask us anything, or share your feedback.</p>
        </div>

        <div className="help-widget-compose-box">
          <input
            type="email"
            className="help-widget-compose-email"
            placeholder="email@example.com"
            value={composeEmail}
            onChange={(e) => setComposeEmail(e.target.value)}
          />
          <textarea
            className="help-widget-compose-textarea"
            placeholder="Message..."
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            autoFocus
          />
          {sendError && <p className="error mt-2">{sendError}</p>}
          <div className="help-widget-compose-actions">
            <span className="help-widget-emoji-btn" aria-hidden="true">🙂</span>
            <button
              className={`help-widget-send-round ${messageText.trim() ? "active" : ""}`}
              onClick={handleSendMessage}
              disabled={sending || !messageText.trim()}
              aria-label="Send message"
            >
              <SendArrowIcon />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="help-widget" role="dialog" aria-label="Help" ref={panelRef}>
      {activeTab === "home" ? (
        <div className="help-widget-hero">
          <div className="help-widget-hero-top">
            <span className="help-widget-brand">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2C12 2 13 8 18 12C13 16 12 22 12 22C12 22 11 16 6 12C11 8 12 2 12 2Z" fill="#ffffff" />
              </svg>
              CRM Ads
            </span>
            <button className="help-widget-close" onClick={onClose} aria-label="Close help">
              <CloseIcon />
            </button>
          </div>
          <p className="help-widget-greeting">
            Hi there <span className="help-widget-wave">👋</span>
            <br />
            How can we help?
          </p>
        </div>
      ) : (
        <div className="help-widget-header-plain">
          <span className="help-widget-header-title">{activeTab === "messages" ? "Messages" : "Help"}</span>
          <button className="help-widget-close plain" onClick={onClose} aria-label="Close help">
            <CloseIcon />
          </button>
        </div>
      )}

      {activeTab !== "messages" && (
        <div className="help-widget-search">
          <input
            type="text"
            placeholder="Search for help"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <SearchIcon />
        </div>
      )}

      <div className="help-widget-body">
        {activeTab === "home" && (
          <div className="help-widget-article-list">
            {filteredArticles.map((a) => (
              <button key={a} className="help-widget-article-item">
                <span>{a}</span>
                <ChevronRightIcon />
              </button>
            ))}
            {filteredArticles.length === 0 && <div className="help-widget-no-results">No articles match "{searchQuery}"</div>}
          </div>
        )}

        {activeTab === "messages" && (
          messageSent ? (
            <div className="help-widget-empty">
              <InboxIcon />
              <strong>Message sent</strong>
              <p>Our team will get back to you soon.</p>
              <button className="help-widget-cta" onClick={() => setMessageSent(false)}>
                Start another conversation
              </button>
            </div>
          ) : (
            <div className="help-widget-empty">
              <InboxIcon />
              <strong>No messages</strong>
              <p>Messages from the team will be shown here</p>
              <button className="help-widget-cta" onClick={() => setComposing(true)}>
                Start a conversation
              </button>
            </div>
          )
        )}

        {activeTab === "help" && (
          <>
            <div className="help-widget-collections-label">{filteredCollections.length} collections</div>
            <div className="help-widget-collections">
              {filteredCollections.map((c) => (
                <button key={c.title} className="help-widget-collection-item">
                  <span className="help-widget-collection-text">
                    <strong>{c.title}</strong>
                    <p>{c.desc}</p>
                    <span className="help-widget-collection-count">{c.count} articles</span>
                  </span>
                  <ChevronRightIcon />
                </button>
              ))}
              {filteredCollections.length === 0 && <div className="help-widget-no-results">No collections match "{searchQuery}"</div>}
            </div>
          </>
        )}
      </div>

      <div className="help-widget-tabs">
        <button className={`help-widget-tab ${activeTab === "home" ? "active" : ""}`} onClick={() => handleTabChange("home")}>
          <HomeIcon />
          Home
        </button>
        <button className={`help-widget-tab ${activeTab === "messages" ? "active" : ""}`} onClick={() => handleTabChange("messages")}>
          <MessagesIcon />
          Messages
        </button>
        <button className={`help-widget-tab ${activeTab === "help" ? "active" : ""}`} onClick={() => handleTabChange("help")}>
          <HelpTabIcon active={activeTab === "help"} />
          Help
        </button>
      </div>
    </div>
  );
}
