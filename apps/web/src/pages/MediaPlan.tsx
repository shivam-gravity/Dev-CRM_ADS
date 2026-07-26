import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import FormattedMessage from "../components/FormattedMessage.js";
import { api } from "../api/client.js";
import { useStreamingChat } from "../hooks/useRealtime.js";
import type { StrategistChatMessage } from "../api/client.js";

const TABS = ["Performance", "Agent activity", "Capabilities", "Decision support"] as const;
type Tab = (typeof TABS)[number];

const SUGGESTIONS: Record<Tab, string[]> = {
  Performance: [
    "How much did I spend on ads today, and how did they perform?",
    "Am I hitting my target ROAS this week?",
    "Which campaign is underperforming right now?"
  ],
  "Agent activity": [
    "What changes did the AI make in the last 24 hours?",
    "Show me every budget shift this week.",
    "Which campaigns were paused automatically?"
  ],
  Capabilities: [
    "What can you help me do with my media plan?",
    "Can you generate a new campaign plan for me?",
    "How do you decide when to scale a winner?"
  ],
  "Decision support": [
    "Should I increase budget on my top campaign?",
    "Is now a good time to launch a new creative test?",
    "Help me decide between Meta and Google for this budget."
  ]
};

interface ChatMessage {
  id: string;
  sender: "user" | "strategist";
  text: string;
}

interface ChatSession {
  id: string;
  startedAt: number;
  preview: string;
  messages: ChatMessage[];
}

const HISTORY_KEY_PREFIX = "polluxa-strategist-history:";
const MAX_HISTORY_SESSIONS = 20;

function loadSessions(businessId: string): ChatSession[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY_PREFIX + businessId);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSessions(businessId: string, sessions: ChatSession[]) {
  try {
    localStorage.setItem(HISTORY_KEY_PREFIX + businessId, JSON.stringify(sessions.slice(0, MAX_HISTORY_SESSIONS)));
  } catch {}
}

function formatRelativeTime(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function toHistory(messages: ChatMessage[]): StrategistChatMessage[] {
  return messages.map((m) => ({ role: m.sender === "user" ? ("user" as const) : ("assistant" as const), content: m.text }));
}

export default function MediaPlan({ businessId }: { businessId: string }) {
  const navigate = useNavigate();
  const { sendStreaming, isStreaming, streamedText } = useStreamingChat(businessId);
  const [activeTab, setActiveTab] = useState<Tab>("Performance");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedHistory, setFailedHistory] = useState<StrategistChatMessage[] | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessions(businessId));
  const [showHistory, setShowHistory] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSessions(loadSessions(businessId));
  }, [businessId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isSending]);

  useEffect(() => {
    if (!showHistory) return;
    function handleClickOutside(e: MouseEvent) {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showHistory]);

  function resizeTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  async function sendToStrategist(history: StrategistChatMessage[]) {
    setError(null);
    setIsSending(true);
    try {
      // Try streaming first, fall back to regular request
      const fullText = await sendStreaming(
        history,
        undefined,
        (text) => {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.sender === "strategist" && last.id.endsWith("-streaming")) {
              return [...prev.slice(0, -1), { ...last, text }];
            }
            return [...prev, { id: `msg-${prev.length}-streaming`, sender: "strategist", text }];
          });
        },
      );
      if (fullText) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.sender === "strategist" && last.id.endsWith("-streaming")) {
            return [...prev.slice(0, -1), { ...last, id: `msg-${prev.length}-s`, text: fullText }];
          }
          return [...prev, { id: `msg-${prev.length}-s`, sender: "strategist", text: fullText }];
        });
      }
      setFailedHistory(null);
    } catch {
      // Fallback to non-streaming
      try {
        const { reply } = await api.chatWithStrategist(businessId, history);
        setMessages((prev) => [...prev, { id: `msg-${prev.length}-s`, sender: "strategist", text: reply }]);
        setFailedHistory(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong reaching the strategist.");
        setFailedHistory(history);
      }
    } finally {
      setIsSending(false);
    }
  }

  async function handleSend(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;

    const history = [...toHistory(messages), { role: "user" as const, content: trimmed }];
    setMessages((prev) => [...prev, { id: `msg-${prev.length}-u`, sender: "user", text: trimmed }]);
    setInputValue("");
    requestAnimationFrame(resizeTextarea);
    await sendToStrategist(history);
  }

  function handleRetry() {
    if (failedHistory) sendToStrategist(failedHistory);
  }

  function handleNewChat() {
    if (messages.length > 0) {
      const archived: ChatSession = {
        id: `session-${Date.now()}`,
        startedAt: Date.now(),
        preview: messages[0].text.slice(0, 60),
        messages
      };
      const next = [archived, ...sessions].slice(0, MAX_HISTORY_SESSIONS);
      setSessions(next);
      saveSessions(businessId, next);
    }
    setMessages([]);
    setError(null);
    setFailedHistory(null);
  }

  function handleLoadSession(session: ChatSession) {
    setMessages(session.messages);
    setError(null);
    setFailedHistory(null);
    setShowHistory(false);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(inputValue);
    }
  }

  return (
    <div className="page-strategist-v2">

      <div className="strat-layout">
        {/* Sidebar */}
        <aside className="strat-sidebar">
          <button className="strat-new-chat-btn" onClick={handleNewChat}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Chat
          </button>

          <div className="strat-sidebar-section">
            <span className="strat-sidebar-label">QUICK ACTIONS</span>
            <button className="strat-sidebar-action" onClick={() => navigate("/campaigns/new")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3l1.9 4.6L18 9l-4.1 1.4L12 15l-1.9-4.6L6 9l4.1-1.4L12 3z" />
              </svg>
              Create Campaign
            </button>
            <button className="strat-sidebar-action" onClick={() => navigate("/manager")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10" />
                <line x1="12" y1="20" x2="12" y2="4" />
                <line x1="6" y1="20" x2="6" y2="14" />
              </svg>
              View Ads Manager
            </button>
          </div>

          {sessions.length > 0 && (
            <div className="strat-sidebar-section">
              <span className="strat-sidebar-label">RECENT CHATS</span>
              <div className="strat-history-list">
                {sessions.slice(0, 8).map((s) => (
                  <button key={s.id} className="strat-history-item" onClick={() => handleLoadSession(s)}>
                    <span className="strat-history-text">{s.preview || "Conversation"}</span>
                    <span className="strat-history-time">{formatRelativeTime(s.startedAt)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* Main chat area */}
        <main className="strat-chat-main">
          <div className="strat-chat-header">
            <div className="strat-chat-title-group">
              <span className="strat-chat-avatar-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
                  <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
                </svg>
              </span>
              <div className="strat-chat-title-text">
                <span className="strat-chat-title">AI Strategist</span>
                <span className="strat-chat-status">
                  <span className={`strat-status-dot ${isSending ? "busy" : ""}`} />
                  {isSending ? "Thinking..." : "Online · Grounded in your data"}
                </span>
              </div>
            </div>
            <div className="strat-chat-header-actions" ref={historyRef}>
              <button className="strat-icon-btn" aria-label="New chat" onClick={handleNewChat} title="New conversation">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <button
                className="strat-icon-btn"
                aria-label="Chat history"
                aria-expanded={showHistory}
                onClick={() => setShowHistory((v) => !v)}
                title="Chat history"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <polyline points="12 7 12 12 15.5 14" />
                </svg>
              </button>

              {showHistory && (
                <div className="strat-history-dropdown">
                  {sessions.length === 0 ? (
                    <div className="strat-history-dropdown-empty">No past conversations yet.</div>
                  ) : (
                    sessions.map((s) => (
                      <button key={s.id} className="strat-history-dropdown-item" onClick={() => handleLoadSession(s)}>
                        <span className="strat-history-dropdown-text">{s.preview || "Conversation"}</span>
                        <span className="strat-history-dropdown-time">{formatRelativeTime(s.startedAt)}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="strat-chat-body">
            {messages.length === 0 ? (
              <div className="strat-empty-state">
                <div className="strat-empty-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#7033f5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
                    <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
                  </svg>
                </div>
                <h2 className="strat-empty-title">What can I help you with?</h2>
                <p className="strat-empty-desc">
                  I can analyze your campaign performance, suggest optimizations, build media plans, or help you make data-driven decisions.
                </p>
                <div className="strat-empty-capabilities">
                  <span className="strat-cap-chip"><span className="strat-cap-dot perf" />Performance Analysis</span>
                  <span className="strat-cap-chip"><span className="strat-cap-dot plan" />Media Planning</span>
                  <span className="strat-cap-chip"><span className="strat-cap-dot decide" />Decision Support</span>
                </div>
              </div>
            ) : (
              <div className="strat-messages">
                {messages.map((m) => (
                  <div key={m.id} className={`strat-msg-row ${m.sender}`}>
                    {m.sender === "strategist" && (
                      <span className="strat-msg-avatar">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 3l1.9 4.6L18 9l-4.1 1.4L12 15l-1.9-4.6L6 9l4.1-1.4L12 3z" />
                        </svg>
                      </span>
                    )}
                    <div className={`strat-bubble ${m.sender}`}>
                      {m.sender === "strategist" ? <FormattedMessage text={m.text} /> : m.text}
                    </div>
                  </div>
                ))}
                {isSending && (
                  <div className="strat-msg-row strategist">
                    <span className="strat-msg-avatar">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 3l1.9 4.6L18 9l-4.1 1.4L12 15l-1.9-4.6L6 9l4.1-1.4L12 3z" />
                      </svg>
                    </span>
                    <div className="strat-bubble strategist typing">
                      <span className="strat-typing-dot" />
                      <span className="strat-typing-dot" />
                      <span className="strat-typing-dot" />
                    </div>
                  </div>
                )}
                {error && (
                  <div className="strat-error-row">
                    <span>{error}</span>
                    {failedHistory && (
                      <button className="strat-retry-btn" onClick={handleRetry}>Retry</button>
                    )}
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          <div className="strat-bottom-area">
            <div className="strat-tabs-row">
              {TABS.map((tab) => (
                <button
                  key={tab}
                  className={`strat-tab ${activeTab === tab ? "active" : ""}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab}
                </button>
              ))}
            </div>

            <div className="strat-suggestions">
              {SUGGESTIONS[activeTab].map((s) => (
                <button key={s} className="strat-suggestion" onClick={() => handleSend(s)} disabled={isSending}>
                  {s}
                </button>
              ))}
            </div>

            <div className="strat-input-row">
              <textarea
                ref={textareaRef}
                className="strat-input"
                placeholder="Ask anything about your campaigns..."
                value={inputValue}
                onChange={(e) => {
                  setInputValue(e.target.value);
                  resizeTextarea();
                }}
                onKeyDown={handleKeyDown}
                disabled={isSending}
                rows={1}
              />
              <button
                className="strat-send-btn"
                onClick={() => handleSend(inputValue)}
                disabled={isSending || !inputValue.trim()}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2 21l21-9L2 3v7l15 2-15 2z" />
                </svg>
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
