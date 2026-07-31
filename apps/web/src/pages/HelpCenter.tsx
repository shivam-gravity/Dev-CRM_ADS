import { currentWorkspaceId } from "../lib/workspace.js";
import { useState } from "react";
import Reveal from "../components/Reveal.js";
import { api } from "../api/client.js";

const FAQS = [
  { q: "How does the AI optimize budgets?", a: "CRM Ads uses multi-armed bandit algorithms to analyze variants with high Click-Through Rates (CTR) and low Cost Per Acquisition (CPA). It automatically shifts budget toward Meta or Google variants capturing higher Return on Ad Spend (ROAS)." },
  { q: "Is Meta Pixel installation automatic?", a: "Pixel conversion event tracking requires connecting your Meta Ads Manager. Once connected, CRM Ads syncs conversion payloads automatically via standard API conversion feeds." },
  { q: "Can I connect multiple ad accounts?", a: "Yes, you can connect multiple Meta/Google ad accounts and store profiles under Workspace settings. Navigate to Admin → Workspace to switch or invite owners." },
  { q: "How often does the AI check performance?", a: "The optimization engine reviews campaign metrics every hour. Budget reallocation happens within 4 hours of detecting under-performing variants, while high-performers are scaled within 2 hours." },
  { q: "What happens when a campaign underperforms?", a: "When ROAS drops below 0.8× target or cost-per-conversion exceeds threshold, the AI first reduces daily budget by 20%. If performance doesn’t recover within 24 hours, the campaign is paused and you’re notified." },
  { q: "Can I override AI decisions?", a: "Absolutely. Every AI optimization is reversible from the Ads Manager. You can resume paused campaigns, restore previous budgets, or lock a campaign to prevent future AI changes." },
  { q: "How does audience targeting work?", a: "The platform uses your brand profile, product data, and historical conversion signals to build lookalike and interest-based audiences. These are synced directly to Meta/Google as custom audiences." },
  { q: "What creative formats are supported?", a: "The AI Generate tool supports static images (1080×1080, 1200×628) and short-form video (up to 15s). You can start from a product URL or a text prompt describing your desired creative." },
];

const GUIDES = [
  { title: "Meta Pixel Integration", time: "4 min", desc: "Install and verify the Meta Ads Conversion Pixel on custom web hosts.", icon: "🔗" },
  { title: "Google Search Dayparting", time: "5 min", desc: "Optimize search bids based on peak conversion hours during weekdays.", icon: "⏰" },
  { title: "AI Budget Optimization", time: "3 min", desc: "Understand how the AI engine reallocates spend across your campaigns.", icon: "🧠" },
  { title: "Creative Studio Quick-Start", time: "6 min", desc: "Generate ad creatives from a product URL in under 60 seconds.", icon: "🎨" },
];

const QUICK_LINKS = [
  { label: "Brand Profile Setup", path: "/brand-profile", icon: "🏢" },
  { label: "Create Campaign", path: "/campaigns/new", icon: "🚀" },
  { label: "Ads Manager", path: "/manager", icon: "📊" },
  { label: "Chat Strategist", path: "/media-plan", icon: "🧠" },
];

export default function HelpCenter() {
  const [ticketSubject, setTicketSubject] = useState("");
  const [ticketBody, setTicketBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [ticketSuccess, setTicketSuccess] = useState(false);
  const [faqSearch, setFaqSearch] = useState("");
  const [activeFaq, setActiveFaq] = useState<number | null>(null);

  async function handleSubmitTicket(e: React.FormEvent) {
    e.preventDefault();
    if (!ticketSubject.trim() || !ticketBody.trim()) return;
    const workspaceId = currentWorkspaceId();
    setSubmitting(true);
    setTicketError(null);
    setTicketSuccess(false);
    try {
      await api.createSupportTicket(workspaceId, { subject: ticketSubject, message: ticketBody });
      setTicketSuccess(true);
      setTicketSubject("");
      setTicketBody("");
    } catch (err) {
      setTicketError(err instanceof Error ? err.message : "Failed to create support ticket.");
    } finally {
      setSubmitting(false);
    }
  }

  const filteredFaqs = FAQS.filter(
    f => f.q.toLowerCase().includes(faqSearch.toLowerCase()) || f.a.toLowerCase().includes(faqSearch.toLowerCase())
  );

  return (
    <div className="page-help-v2">
      <div className="hc-hero">
        <div className="hc-hero-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#7033f5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <h1 className="hc-hero-title">How can we help?</h1>
        <p className="hc-hero-subtitle">Search our knowledge base or get in touch with our support team.</p>
        <div className="hc-search-wrap">
          <svg className="hc-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={faqSearch}
            onChange={(e) => setFaqSearch(e.target.value)}
            placeholder="Search FAQs, guides, topics..."
            className="hc-search-input"
          />
        </div>
      </div>

      <div className="hc-quick-links">
        {QUICK_LINKS.map((link) => (
          <a key={link.path} href={link.path} className="hc-quick-link-card">
            <span className="hc-quick-link-icon">{link.icon}</span>
            <span className="hc-quick-link-label">{link.label}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </a>
        ))}
      </div>

      <div className="hc-main-grid">
        <div className="hc-left-col">
          <Reveal>
            <section className="hc-faq-section">
              <h2 className="hc-section-title">Frequently Asked Questions</h2>
              <div className="hc-faq-list">
                {filteredFaqs.length === 0 ? (
                  <p className="hc-no-results">No results found for &ldquo;{faqSearch}&rdquo;</p>
                ) : (
                  filteredFaqs.map((faq, idx) => {
                    const isOpen = activeFaq === idx;
                    return (
                      <div key={idx} className={`hc-faq-item ${isOpen ? "open" : ""}`}>
                        <button className="hc-faq-trigger" onClick={() => setActiveFaq(isOpen ? null : idx)}>
                          <span className="hc-faq-q">{faq.q}</span>
                          <span className={`hc-faq-chevron ${isOpen ? "open" : ""}`}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </span>
                        </button>
                        {isOpen && (
                          <Reveal>
                            <p className="hc-faq-a">{faq.a}</p>
                          </Reveal>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </Reveal>

          <Reveal>
            <section className="hc-guides-section">
              <h2 className="hc-section-title">Getting Started Guides</h2>
              <div className="hc-guides-grid">
                {GUIDES.map((g) => (
                  <div key={g.title} className="hc-guide-card">
                    <div className="hc-guide-header">
                      <span className="hc-guide-icon">{g.icon}</span>
                      <span className="hc-guide-time">{g.time}</span>
                    </div>
                    <h3 className="hc-guide-title">{g.title}</h3>
                    <p className="hc-guide-desc">{g.desc}</p>
                  </div>
                ))}
              </div>
            </section>
          </Reveal>
        </div>

        <div className="hc-right-col">
          <Reveal>
            <section className="hc-ticket-section">
              <div className="hc-ticket-header">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7033f5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
                <h2 className="hc-section-title">Contact Support</h2>
              </div>
              <p className="hc-ticket-desc">Our team typically responds within 4 hours during business days.</p>

              {ticketSuccess && (
                <div className="hc-ticket-success">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                  <span>Ticket submitted! We'll get back to you shortly.</span>
                </div>
              )}

              <form onSubmit={handleSubmitTicket} className="hc-ticket-form">
                <label className="hc-form-label">
                  <span>Subject</span>
                  <input
                    type="text"
                    value={ticketSubject}
                    onChange={(e) => setTicketSubject(e.target.value)}
                    placeholder="e.g. Meta Sync connection failed"
                    required
                    className="hc-form-input"
                  />
                </label>
                <label className="hc-form-label">
                  <span>Description</span>
                  <textarea
                    value={ticketBody}
                    onChange={(e) => setTicketBody(e.target.value)}
                    placeholder="Describe your issue in detail..."
                    rows={5}
                    required
                    className="hc-form-textarea"
                  />
                </label>
                {ticketError && <p className="error">{ticketError}</p>}
                <button className="hc-submit-btn" type="submit" disabled={submitting}>
                  {submitting ? "Sending..." : "Send Message"}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2 21l21-9L2 3v7l15 2-15 2z" />
                  </svg>
                </button>
              </form>
            </section>
          </Reveal>

          <Reveal>
            <div className="hc-contact-card">
              <h3>Need urgent help?</h3>
              <p>For critical issues affecting live campaigns, reach us directly.</p>
              <div className="hc-contact-methods">
                <div className="hc-contact-method">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                    <polyline points="22,6 12,13 2,6" />
                  </svg>
                  <span>support@polluxa.io</span>
                </div>
                <div className="hc-contact-method">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <span>Chat Strategist (in-app)</span>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </div>
  );
}
