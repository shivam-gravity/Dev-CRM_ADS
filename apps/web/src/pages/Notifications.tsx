import { currentWorkspaceId } from "../lib/workspace.js";
import { useEffect, useState } from "react";
import { api, Notification } from "../api/client.js";
import Reveal from "../components/Reveal.js";

export default function Notifications({ businessId }: { businessId: string }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [emailAlerts, setEmailAlerts] = useState(true);
  const [slackAlerts, setSlackAlerts] = useState(false);
  const [dailyDigest, setDailyDigest] = useState(true);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [prefsSaved, setPrefsSaved] = useState(false);
  const [prefsError, setPrefsError] = useState<string | null>(null);

  const wsId = currentWorkspaceId();

  async function loadNotifications() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listNotifications(wsId);
      setNotifications(data);
    } catch {
      setError("Failed to fetch notification alerts.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadNotifications();
  }, [businessId]);

  useEffect(() => {
    api.getNotificationPreferences(wsId).then(prefs => {
      setEmailAlerts(prefs.emailAlerts);
      setSlackAlerts(prefs.slackAlerts);
      setDailyDigest(prefs.digestAlerts);
    }).catch(() => {
      setPrefsError("Failed to load notification preferences.");
    });
  }, [wsId]);

  async function handleSavePreferences() {
    setSavingPrefs(true);
    setPrefsError(null);
    setPrefsSaved(false);
    try {
      await api.setNotificationPreferences(wsId, {
        emailAlerts,
        slackAlerts,
        digestAlerts: dailyDigest,
      });
      setPrefsSaved(true);
    } catch {
      setPrefsError("Failed to save notification preferences.");
    } finally {
      setSavingPrefs(false);
    }
  }

  async function handleMarkRead(id: string) {
    try {
      await api.markRead(id);
      setNotifications(prev =>
        prev.map(n => n.id === id ? { ...n, read: true } : n)
      );
    } catch {
      setError("Failed to mark notification read.");
    }
  }

  async function handleMarkAllRead() {
    try {
      await api.markAllRead(wsId);
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    } catch {
      setError("Failed to update status.");
    }
  }

  return (
    <div className="page-notifications">
      <div className="page-header">
        <div>
          <h1>Alerts &amp; Notifications</h1>
          <p className="subtitle">Real-time alerts, AI optimization recommendations, and billing reminders.</p>
        </div>
        <button className="btn btn-secondary" onClick={handleMarkAllRead}>Mark All Read</button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="notifications-layout">
        {/* Alerts Feed */}
        <div className="alerts-feed flex-col gap-4">
          <section className="card">
            <h2>Notifications Inbox</h2>
            {loading ? (
              <div className="campaigns-loading mt-3">
                {[1, 2].map(i => <div key={i} className="campaign-row-skeleton" />)}
              </div>
            ) : notifications.length === 0 ? (
              <p className="muted-text mt-3">No notifications found.</p>
            ) : (
              <Reveal>
                <div className="notifications-feed-list mt-3">
                  {notifications.map((n) => (
                    <div key={n.id} className={`notification-item-card ${n.read ? "read" : "unread"}`}>
                      <div className="flex justify-between items-start gap-4">
                        <div>
                          <strong className="notification-title">{n.title}</strong>
                          <p className="notification-desc mt-1">{n.message}</p>
                          <span className="notification-time font-size-11 mt-2 block">{new Date(n.createdAt).toLocaleDateString()}</span>
                        </div>
                        {!n.read && (
                          <button className="btn btn-sm btn-secondary" onClick={() => handleMarkRead(n.id)}>
                            Mark Read
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Reveal>
            )}
          </section>
        </div>

        {/* Preferences settings */}
        <div className="preferences-panel">
          <section className="card">
            <h2>Preference Settings</h2>
            <div className="wizard-form mt-3">
              <label className="auth-checkbox-label">
                <input type="checkbox" checked={emailAlerts} onChange={(e) => setEmailAlerts(e.target.checked)} />
                <span>Send campaign anomaly alerts by Email</span>
              </label>
              <label className="auth-checkbox-label mt-3">
                <input type="checkbox" checked={slackAlerts} onChange={(e) => setSlackAlerts(e.target.checked)} />
                <span>Send reports to connected Slack channel</span>
              </label>
              <label className="auth-checkbox-label mt-3">
                <input type="checkbox" checked={dailyDigest} onChange={(e) => setDailyDigest(e.target.checked)} />
                <span>Daily digest strategy brief</span>
              </label>
              {prefsError && <p className="error mt-3">{prefsError}</p>}
              {prefsSaved && <p className="muted-text mt-3">Preferences updated.</p>}
              <button
                className="btn btn-primary btn-full mt-4"
                disabled={savingPrefs}
                onClick={handleSavePreferences}
              >
                {savingPrefs ? "Saving..." : "Save Preferences"}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
