import { currentWorkspaceId } from "../lib/workspace.js";
import { useEffect, useState } from "react";
import Reveal from "../components/Reveal.js";
import { api, SavedAudience } from "../api/client.js";

function formatReach(estimate: { usersLowerBound: number; usersUpperBound: number; source: "meta" | "heuristic" }): string {
  const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`);
  const suffix = estimate.source === "heuristic" ? " (estimate)" : "";
  return `${fmt(estimate.usersLowerBound)} - ${fmt(estimate.usersUpperBound)}${suffix}`;
}

export default function AudienceBuilder({ businessId }: { businessId: string }) {
  const wsId = currentWorkspaceId();
  const [audienceName, setAudienceName] = useState("");
  
  // Demographics
  const [ageMin, setAgeMin] = useState(18);
  const [ageMax, setAgeMax] = useState(65);
  const [gender, setGender] = useState("all");

  // Inclusions/Exclusions
  const [locations, setLocations] = useState<string[]>(["United States"]);
  const [locationInput, setLocationInput] = useState("");
  
  const [interests, setInterests] = useState<string[]>(["Marketing", "E-commerce"]);
  const [interestInput, setInterestInput] = useState("");

  const [exclusions, setExclusions] = useState<string[]>([]);
  const [exclusionInput, setExclusionInput] = useState("");

  // Lookalikes
  const [lookalikeSource, setLookalikeSource] = useState("");
  const [lookalikePercentage, setLookalikePercentage] = useState("1");
  const [lookalikeName, setLookalikeName] = useState("");
  const [creatingLookalike, setCreatingLookalike] = useState(false);

  // Meta Custom Audience (seed list) creation
  const [customName, setCustomName] = useState("");
  const [customSeed, setCustomSeed] = useState(""); // newline/comma-separated emails or phones
  const [creatingCustom, setCreatingCustom] = useState(false);
  const [audienceMsg, setAudienceMsg] = useState<string | null>(null);

  // Saved segments
  const [savedAudiences, setSavedAudiences] = useState<SavedAudience[]>([]);
  const [reachByAudience, setReachByAudience] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    api.listAudiences(wsId).then((list) => {
      setSavedAudiences(list);
      for (const aud of list) {
        api.getReachEstimate(wsId, aud.id)
          .then((estimate) => setReachByAudience((prev) => ({ ...prev, [aud.id]: formatReach(estimate) })))
          .catch(() => {});
      }
    }).catch(() => {});
  }, [wsId]);

  function addLocation() {
    if (locationInput.trim() && !locations.includes(locationInput.trim())) {
      setLocations([...locations, locationInput.trim()]);
      setLocationInput("");
    }
  }

  function addInterest() {
    if (interestInput.trim() && !interests.includes(interestInput.trim())) {
      setInterests([...interests, interestInput.trim()]);
      setInterestInput("");
    }
  }

  function addExclusion() {
    if (exclusionInput.trim() && !exclusions.includes(exclusionInput.trim())) {
      setExclusions([...exclusions, exclusionInput.trim()]);
      setExclusionInput("");
    }
  }

  async function handleSaveAudience() {
    if (!audienceName.trim()) {
      setSaveError("Please name your audience segment.");
      return;
    }
    if (ageMin > ageMax) {
      setSaveError("Min Age must be less than or equal to Max Age.");
      return;
    }
    setSaveError(null);
    setSaving(true);
    try {
      const saved = await api.createAudience(wsId, {
        name: audienceName,
        ageMin,
        ageMax,
        gender: gender as "all" | "male" | "female",
        locations,
        interests,
        exclusions,
      });
      setSavedAudiences((prev) => [saved, ...prev]);
      setAudienceName("");
      api.getReachEstimate(wsId, saved.id)
        .then((estimate) => setReachByAudience((prev) => ({ ...prev, [saved.id]: formatReach(estimate) })))
        .catch(() => {});
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save audience.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteAudience(id: string) {
    await api.deleteAudience(id).catch(() => {});
    setSavedAudiences((prev) => prev.filter((a) => a.id !== id));
  }

  // Custom Audiences created on Meta (have a metaCustomAudienceId) are the only valid lookalike sources.
  const customSources = savedAudiences.filter((a) => a.type === "custom" && a.metaCustomAudienceId);

  async function handleCreateCustomAudience() {
    if (!customName.trim()) { setAudienceMsg("Name your custom audience first."); return; }
    setAudienceMsg(null);
    setCreatingCustom(true);
    try {
      // Split the seed list into emails vs phones (a value with '@' is an email, else a phone).
      const tokens = customSeed.split(/[\n,]+/).map((t) => t.trim()).filter(Boolean);
      const emails = tokens.filter((t) => t.includes("@"));
      const phones = tokens.filter((t) => !t.includes("@"));
      const saved = await api.createCustomAudience(wsId, {
        name: customName.trim(), subtype: "CUSTOM",
        emails: emails.length ? emails : undefined, phones: phones.length ? phones : undefined,
        ageMin, ageMax, gender: gender as "all" | "male" | "female", locations,
      });
      setSavedAudiences((prev) => [saved, ...prev]);
      setCustomName(""); setCustomSeed("");
      setAudienceMsg(`Custom Audience "${saved.name}" created${saved.metaCustomAudienceId ? "" : " (mock — connect Meta for a real audience)"}.`);
    } catch (err) {
      setAudienceMsg(err instanceof Error ? err.message : "Failed to create custom audience.");
    } finally {
      setCreatingCustom(false);
    }
  }

  async function handleCreateLookalike() {
    if (!lookalikeSource) { setAudienceMsg("Pick a source custom audience."); return; }
    setAudienceMsg(null);
    setCreatingLookalike(true);
    try {
      const src = savedAudiences.find((a) => a.id === lookalikeSource);
      const saved = await api.createLookalike(wsId, {
        name: lookalikeName.trim() || `Lookalike of ${src?.name ?? "source"}`,
        sourceAudienceId: lookalikeSource,
        ratio: (parseInt(lookalikePercentage) || 1) / 100,
        targetCountries: locations,
      });
      setSavedAudiences((prev) => [saved, ...prev]);
      setLookalikeName(""); setLookalikeSource("");
      setAudienceMsg(`Lookalike "${saved.name}" created.`);
    } catch (err) {
      setAudienceMsg(err instanceof Error ? err.message : "Failed to create lookalike.");
    } finally {
      setCreatingLookalike(false);
    }
  }

  // Calculate reach estimation meter
  const interestScore = interests.length * 1.5;
  const locationScore = locations.length * 3;
  const rawReach = Math.max(1, 20 - interestScore - locationScore);
  const reachPercentage = Math.min(100, Math.max(10, rawReach * 5));

  return (
    <div className="audience-builder">
      <div className="page-header">
        <div>
          <h1>Audience Builder</h1>
          <p className="subtitle">Design specific segments and generate lookalike targets for your campaigns.</p>
        </div>
      </div>

      <div className="audience-builder-layout">
        {/* Left Side: Setup Forms */}
        <div className="audience-setup flex-col gap-4">
          <section className="card">
            <h2>Demographics</h2>
            <div className="wizard-form mt-3">
              <label>
                Audience Segment Name
                <input
                  type="text"
                  value={audienceName}
                  onChange={(e) => setAudienceName(e.target.value)}
                  placeholder="e.g. US Tech Marketers 25-45"
                />
              </label>

              <div className="form-row-3">
                <label>
                  Min Age
                  <input
                    type="number"
                    value={ageMin}
                    onChange={(e) => setAgeMin(parseInt(e.target.value) || 18)}
                    min={13}
                    max={65}
                  />
                </label>
                <label>
                  Max Age
                  <input
                    type="number"
                    value={ageMax}
                    onChange={(e) => setAgeMax(parseInt(e.target.value) || 65)}
                    min={18}
                    max={65}
                  />
                </label>
                <label>
                  Gender
                  <select value={gender} onChange={(e) => setGender(e.target.value)}>
                    <option value="all">All</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                  </select>
                </label>
              </div>
            </div>
          </section>

          <section className="card">
            <h2>Detailed Targeting</h2>
            <div className="wizard-form mt-3">
              {/* Locations */}
              <label>
                Target Locations
                <div className="tags-input-row">
                  <input
                    type="text"
                    value={locationInput}
                    onChange={(e) => setLocationInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addLocation())}
                    placeholder="e.g. United States, France"
                  />
                  <button type="button" className="btn btn-secondary" onClick={addLocation}>Add</button>
                </div>
                <div className="audience-pills-row mt-2">
                  {locations.map((loc) => (
                    <span key={loc} className="audience-pill-saved">
                      {loc}
                      <button type="button" className="audience-pill-remove" onClick={() => setLocations(locations.filter(x => x !== loc))}>×</button>
                    </span>
                  ))}
                </div>
              </label>

              {/* Interests */}
              <label>
                Include Interests / Demographics
                <div className="tags-input-row">
                  <input
                    type="text"
                    value={interestInput}
                    onChange={(e) => setInterestInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addInterest())}
                    placeholder="e.g. Advertising, Marketing, Retail"
                  />
                  <button type="button" className="btn btn-secondary" onClick={addInterest}>Add</button>
                </div>
                <div className="audience-pills-row mt-2">
                  {interests.map((int) => (
                    <span key={int} className="audience-pill-saved">
                      {int}
                      <button type="button" className="audience-pill-remove" onClick={() => setInterests(interests.filter(x => x !== int))}>×</button>
                    </span>
                  ))}
                </div>
              </label>

              {/* Exclusions */}
              <label>
                Exclude Interests / Behaviors
                <div className="tags-input-row">
                  <input
                    type="text"
                    value={exclusionInput}
                    onChange={(e) => setExclusionInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addExclusion())}
                    placeholder="e.g. Competitors, Existing Customers"
                  />
                  <button type="button" className="btn btn-secondary" onClick={addExclusion}>Exclude</button>
                </div>
                <div className="audience-pills-row mt-2">
                  {exclusions.map((ex) => (
                    <span key={ex} className="audience-pill-saved">
                      {ex}
                      <button type="button" className="audience-pill-remove" onClick={() => setExclusions(exclusions.filter(x => x !== ex))}>×</button>
                    </span>
                  ))}
                </div>
              </label>
            </div>
          </section>

          <section className="card">
            <h2>Custom Audience (Meta)</h2>
            <p className="field-hint">Upload a customer list to build a Meta Custom Audience. It becomes targetable on launched ads and can seed a Lookalike below.</p>
            <div className="wizard-form mt-3">
              <label>
                Custom Audience Name
                <input type="text" value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="e.g. Existing Customers" />
              </label>
              <label className="mt-3">
                Seed list — emails or phone numbers (one per line or comma-separated)
                <textarea rows={4} value={customSeed} onChange={(e) => setCustomSeed(e.target.value)} placeholder={"jane@acme.com\n+15551234567"} />
                <span className="field-hint">Hashed (SHA-256) before upload — raw values never leave the server unhashed. Uses the demographics/locations above for size estimates.</span>
              </label>
              <button type="button" className="btn btn-secondary mt-2" onClick={handleCreateCustomAudience} disabled={creatingCustom}>
                {creatingCustom ? "Creating…" : "Create Custom Audience"}
              </button>
            </div>
          </section>

          <section className="card">
            <h2>Lookalike Audiences</h2>
            <div className="wizard-form mt-3">
              <label>
                Source Custom Audience
                <select value={lookalikeSource} onChange={(e) => setLookalikeSource(e.target.value)}>
                  <option value="">Select source custom audience…</option>
                  {customSources.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                {customSources.length === 0 && (
                  <span className="field-hint">No source yet — create a Custom Audience above first (a lookalike needs a real seed audience).</span>
                )}
              </label>

              {lookalikeSource && (
                <>
                  <label className="mt-3">
                    Lookalike Name
                    <input type="text" value={lookalikeName} onChange={(e) => setLookalikeName(e.target.value)} placeholder="e.g. Lookalike — Existing Customers 1%" />
                  </label>
                  <label className="mt-3">
                    Lookalike Percentage: {lookalikePercentage}%
                    <input
                      type="range"
                      min="1"
                      max="10"
                      value={lookalikePercentage}
                      onChange={(e) => setLookalikePercentage(e.target.value)}
                      className="calculator-slider"
                    />
                    <span className="field-hint">Smaller percentage focuses on maximum similarity. Larger focuses on maximum reach. Target countries use the locations above.</span>
                  </label>
                  <button type="button" className="btn btn-secondary mt-2" onClick={handleCreateLookalike} disabled={creatingLookalike}>
                    {creatingLookalike ? "Creating…" : "Create Lookalike"}
                  </button>
                </>
              )}
              {audienceMsg && <p className="field-hint mt-2">{audienceMsg}</p>}
            </div>
          </section>
        </div>

        {/* Right Side: Estimated Reach & Saved Library */}
        <div className="audience-insights flex-col gap-4">
          <section className="card reach-estimation-card">
            <h2>Estimated Audience Size</h2>
            
            <div className="reach-gauge mt-4">
              <div className="reach-gauge-bar" style={{ width: `${reachPercentage}%` }} />
              <div className="reach-labels">
                <span>Specific</span>
                <span>Broad</span>
              </div>
            </div>

            <div className="reach-metrics mt-4">
              <div className="reach-metric-row">
                <span>Total Est. Reach:</span>
                <strong>{(rawReach * 0.9).toFixed(1)}M - {(rawReach * 1.5).toFixed(1)}M people</strong>
              </div>
              <div className="reach-metric-row">
                <span>Targeting Accuracy:</span>
                <span className="live-dot" style={{ background: reachPercentage > 30 && reachPercentage < 75 ? "var(--accent-2)" : "var(--danger)" }}>
                  {reachPercentage > 30 && reachPercentage < 75 ? " Balanced" : " Broad/Narrow"}
                </span>
              </div>
            </div>

            {saveError && <p className="error mt-2">{saveError}</p>}
            <button className="btn btn-primary btn-full mt-4" onClick={handleSaveAudience} disabled={saving}>
              {saving ? "Saving…" : "Save Target Segment"}
            </button>
          </section>

          {/* Saved Audience Library */}
          <section className="card">
            <h2>Audience Segments Library</h2>
            {savedAudiences.length === 0 ? (
              <p className="muted-text mt-3">No custom saved segments yet. Set one up above and click Save.</p>
            ) : (
              <Reveal>
                <div className="saved-audiences-list mt-3">
                  {savedAudiences.map((aud) => (
                    <div key={aud.id} className="audience-library-item">
                      <div className="audience-lib-header">
                        <strong>{aud.name}</strong>
                        <span>{reachByAudience[aud.id] ?? "Estimating…"} reach</span>
                        <button type="button" className="audience-pill-remove" onClick={() => handleDeleteAudience(aud.id)} title="Delete">×</button>
                      </div>
                      <div className="audience-lib-details mt-2">
                        <p><strong>Locations:</strong> {aud.locations.join(", ")}</p>
                        <p><strong>Interests:</strong> {aud.interests.join(", ")}</p>
                        <p><strong>Age:</strong> {aud.ageMin}-{aud.ageMax === 65 ? "65+" : aud.ageMax}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </Reveal>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
