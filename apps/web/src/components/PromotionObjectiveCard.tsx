import { useEffect, useRef, useState } from "react";
import { DropdownField, type Option } from "./DropdownField.js";
import { LightningIcon, TargetIcon, PinIcon, MetaInfinityIcon, GoogleIcon } from "./icons.js";
import { SUPPORTED_PLATFORMS, ACTIVE_PLATFORM_VALUES } from "../constants/platforms.js";
import { api, type BudgetSimulation, type CampaignObjectiveOption } from "../api/client.js";
import { useCurrency } from "../providers/CurrencyProvider.js";
import { suggestedDailyBudgetWholeUnits } from "../constants/money.js";

// "Promotion Objective" card (AdsGo-style). Its selections drive the campaign in TWO ways:
//   1. LIVE projection — objective/budget/platforms/countries recompute an estimated
//      impressions/clicks/conv/ROAS preview (debounced POST /campaigns/simulate) as you change them.
//   2. On Generate — the selected budget / conversion event / target locations are applied to the
//      generated campaign before it launches (see onGenerate → PromotionObjectiveValues).
// Rendered after a Deep Research URL search completes (see NewCampaign.tsx).

/** The card's selections, surfaced to the parent so publish can apply them to the campaign. */
export interface PromotionObjectiveValues {
  objective: string;            // card goal: sales | leads | awareness | traffic
  metaObjective: string;        // mapped Meta objective: OUTCOME_SALES | OUTCOME_LEADS | ...
  conversionEvent?: string;     // PURCHASE | ADD_TO_CART | LEAD | ... (empty if none picked)
  dailyBudgetCents: number;
  platforms: ("meta" | "google")[];
  locations: string[];          // human-readable country names (e.g. "United States")
  /** online_shopping | solution_service | local_store | app. Decides the default conversion event
   *  when the Ad Performance Goal picker is left empty. */
  businessType: string;
  /** long_term | short_term. Short-term gives the campaign an end date. */
  promotionType: string;
}

// Card goal → Meta campaign objective (the format budgetSimulator / the pipeline expect).
// Covers all 6 Meta ODAX objectives (see apps/api/src/modules/adapters/metaObjectives.ts).
const OBJECTIVE_TO_META: Record<string, string> = {
  sales: "OUTCOME_SALES",
  leads: "OUTCOME_LEADS",
  awareness: "OUTCOME_AWARENESS",
  traffic: "OUTCOME_TRAFFIC",
  engagement: "OUTCOME_ENGAGEMENT",
  app_promotion: "OUTCOME_APP_PROMOTION",
};

const SIMULATE_DEBOUNCE_MS = 350;

function formatCompact(n: number): string {
  return Number(n || 0).toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 });
}

// Broad set of ad markets (value = ISO alpha-2 code the backend maps for Meta geo_locations; the
// backend also accepts full country names, so the label could be sent too). Kept as a curated list
// of the highest-volume Meta ad markets rather than all ~249 countries to keep the dropdown usable.
const COUNTRY_OPTIONS: Option[] = [
  { value: "US", label: "United States" }, { value: "GB", label: "United Kingdom" },
  { value: "CA", label: "Canada" }, { value: "AU", label: "Australia" },
  { value: "IN", label: "India" }, { value: "DE", label: "Germany" },
  { value: "FR", label: "France" }, { value: "BR", label: "Brazil" },
  { value: "JP", label: "Japan" }, { value: "AE", label: "United Arab Emirates" },
  { value: "SG", label: "Singapore" }, { value: "MX", label: "Mexico" },
  { value: "ES", label: "Spain" }, { value: "IT", label: "Italy" },
  { value: "NL", label: "Netherlands" }, { value: "SE", label: "Sweden" },
  { value: "NO", label: "Norway" }, { value: "DK", label: "Denmark" },
  { value: "IE", label: "Ireland" }, { value: "CH", label: "Switzerland" },
  { value: "AT", label: "Austria" }, { value: "BE", label: "Belgium" },
  { value: "PL", label: "Poland" }, { value: "PT", label: "Portugal" },
  { value: "NZ", label: "New Zealand" }, { value: "ZA", label: "South Africa" },
  { value: "NG", label: "Nigeria" }, { value: "EG", label: "Egypt" },
  { value: "SA", label: "Saudi Arabia" }, { value: "TR", label: "Turkey" },
  { value: "ID", label: "Indonesia" }, { value: "MY", label: "Malaysia" },
  { value: "PH", label: "Philippines" }, { value: "TH", label: "Thailand" },
  { value: "VN", label: "Vietnam" }, { value: "KR", label: "South Korea" },
  { value: "HK", label: "Hong Kong" }, { value: "AR", label: "Argentina" },
  { value: "CL", label: "Chile" }, { value: "CO", label: "Colombia" },
];

const PLATFORM_ICONS: Record<string, React.ReactNode> = {
  meta: <MetaInfinityIcon />,
  google: <GoogleIcon />,
};

const CHANNEL_OPTIONS: Option[] = SUPPORTED_PLATFORMS.map((p) => ({
  value: p.value,
  label: p.label,
  icon: PLATFORM_ICONS[p.value],
  disabled: p.status !== "active",
}));

// The full Meta ODAX objective set (matches the CRM's Create Campaign list and the backend's
// metaObjectives.ts). Each value maps to a Meta OUTCOME_* objective via OBJECTIVE_TO_META above.
const OBJECTIVE_OPTIONS: Option[] = [
  { value: "leads", label: "Lead Generation", description: "Collect leads via Meta forms or website." },
  { value: "sales", label: "Sales", description: "Drive purchases or key website actions." },
  { value: "awareness", label: "Awareness", description: "Reach people likely to remember your ad." },
  { value: "traffic", label: "Traffic", description: "Send people to a destination." },
  { value: "engagement", label: "Engagement", description: "Get more likes, comments & shares." },
  { value: "app_promotion", label: "App Promotion", description: "Get people to install or use your app." },
];

const BUSINESS_TYPE_OPTIONS: Option[] = [
  { value: "online_shopping", label: "Online Shopping" },
  { value: "solution_service", label: "Solution & Online Service" },
  { value: "local_store", label: "Local Store & Service" },
  { value: "app", label: "App" },
];

const PROMOTION_TYPE_OPTIONS: Option[] = [
  { value: "long_term", label: "Long-term" },
  { value: "short_term", label: "Short-term" },
];

// Uppercase because these are Graph API custom_event_type enum values, which is what
// PromotionObjectiveValues.conversionEvent has always claimed to carry. They were lowercase here
// while CampaignBuilder's identical list was uppercase; the API now normalises either form, but
// matching the enum keeps this list comparable to the per-objective rules fetched below.
const CONVERSION_EVENT_OPTIONS: Option[] = [
  { value: "PURCHASE", label: "Purchase" },
  { value: "ADD_TO_CART", label: "Add to Cart" },
  { value: "LEAD", label: "Lead" },
  { value: "COMPLETE_REGISTRATION", label: "Complete Registration" },
  { value: "LANDING_PAGE_VIEW", label: "Landing Page View" },
];

export function PromotionObjectiveCard({ onGenerate, onChange, generating, generateLabel = "Generate Campaign" }: {
  /** Primary CTA. Receives the card's current selections so publish can apply them to the campaign.
   *  Omit to hide the button. */
  onGenerate?: (values: PromotionObjectiveValues) => void;
  /**
   * Fires whenever a selection changes, so the parent always holds the current values.
   *
   * Needed because the card is now shown BEFORE generation: the run can be started from outside it
   * (pressing Enter in the URL field), and that path has no access to state living inside this
   * component. Reporting on change keeps the two entry points submitting identical values instead
   * of one of them silently falling back to defaults.
   */
  onChange?: (values: PromotionObjectiveValues) => void;
  generating?: boolean;
  generateLabel?: string;
} = {}) {
  const { currency, adAccountCountry, isLoading: currencyLoading } = useCurrency();
  const [businessType, setBusinessType] = useState<string[]>(["solution_service"]);
  const [objective, setObjective] = useState<string[]>(["sales"]);
  const [conversionEvent, setConversionEvent] = useState<string[]>([]);
  const [channels, setChannels] = useState<string[]>([...ACTIVE_PLATFORM_VALUES]);
  // Seeded from the connected ad account below. "US" is only the value shown for the instant
  // before that resolves (and the fallback when nothing is connected) — not a real default.
  const [countries, setCountries] = useState<string[]>(["US"]);
  const [promotionType, setPromotionType] = useState<string[]>(["long_term"]);
  const [dailyBudget, setDailyBudget] = useState("50");
  const [simulation, setSimulation] = useState<BudgetSimulation | null>(null);
  const simTimer = useRef<number | null>(null);

  /**
   * ── Seed the defaults from the CONNECTED AD ACCOUNT ──────────────────────────────────────────
   *
   * These selections now gate generation, so a wrong default is a wrong campaign rather than a
   * cosmetic detail. Both hardcoded values were wrong for this deployment specifically:
   *
   *   Target Locations "US"  — on an INR/India account. Targeting the wrong country is the exact
   *                            money bug already fixed once in the backend fallback; leaving it as
   *                            the UI default just reintroduces it one layer up.
   *   Daily budget "50"      — ₹50 is BELOW Meta's ₹100 minimum for INR, so the ad set would have
   *                            been rejected or silently floored.
   *
   * Only ever seeds a field the user has not touched: once someone edits a value, the account
   * resolving a beat later must not yank it back.
   */
  const [countriesTouched, setCountriesTouched] = useState(false);
  const [budgetTouched, setBudgetTouched] = useState(false);

  useEffect(() => {
    if (countriesTouched || !adAccountCountry) return;
    // Only if it is one of the offered markets — otherwise the dropdown would show a value it
    // cannot render or let the user reselect.
    if (COUNTRY_OPTIONS.some((o) => o.value === adAccountCountry)) setCountries([adAccountCountry]);
  }, [adAccountCountry, countriesTouched]);

  useEffect(() => {
    if (budgetTouched || currencyLoading) return;
    setDailyBudget(String(suggestedDailyBudgetWholeUnits(currency)));
  }, [currency, currencyLoading, budgetTouched]);

  const dailyBudgetCents = Math.max(0, Math.round((parseFloat(dailyBudget) || 0) * 100));
  const metaObjective = OBJECTIVE_TO_META[objective[0]] ?? "OUTCOME_TRAFFIC";
  const platforms = channels.filter((c): c is "meta" | "google" => c === "meta" || c === "google");
  const locationNames = countries.map((c) => COUNTRY_OPTIONS.find((o) => o.value === c)?.label ?? c);

  // Live projection: recompute the ballpark estimate whenever objective/budget/platforms/countries
  // change — debounced so typing in the budget field doesn't spam the API. This is the real-time
  // feedback loop the card drives (POST /campaigns/simulate → budgetSimulator).
  useEffect(() => {
    if (simTimer.current) window.clearTimeout(simTimer.current);
    if (!dailyBudgetCents || platforms.length === 0) { setSimulation(null); return; }
    simTimer.current = window.setTimeout(async () => {
      try {
        // currency is what makes the CPM assumptions market-correct: the budget is in the ad
        // account's currency, while the base CPM constants are USD figures.
        const sim = await api.simulateCampaign({ objective: metaObjective, dailyBudgetCents, platforms, countries, currency });
        setSimulation(sim);
      } catch { /* best-effort — a failure just hides the preview */ }
    }, SIMULATE_DEBOUNCE_MS);
    return () => { if (simTimer.current) window.clearTimeout(simTimer.current); };
  }, [metaObjective, dailyBudgetCents, platforms.join(","), countries.join(",")]);

  // Meta accepts only certain conversion events per objective (Leads cannot take PURCHASE, Sales
  // cannot take LEAD) and rejects a crossed pair at ad set creation. Rules come from the API so
  // this picker and the server-side guards stay in step. Best-effort: on a fetch failure the full
  // list shows and the API still rejects a bad pair at generate time.
  const [objectiveRules, setObjectiveRules] = useState<CampaignObjectiveOption[]>([]);
  useEffect(() => {
    api.getCampaignObjectives().then((r) => setObjectiveRules(r.objectives)).catch(() => {});
  }, []);

  const allowedConversionEvents =
    objectiveRules.find((o) => o.value === metaObjective)?.conversionEvents ?? null;
  const conversionEventOptions = allowedConversionEvents
    ? CONVERSION_EVENT_OPTIONS.filter((o) => allowedConversionEvents.includes(o.value))
    : CONVERSION_EVENT_OPTIONS;

  // Switching the objective can strand a selection the new objective cannot carry (picking Sales +
  // Purchase, then switching to Leads). Drop it rather than silently generating a campaign that
  // cannot publish; the field is optional, so empty is a valid resting state.
  useEffect(() => {
    if (!conversionEvent.length || !allowedConversionEvents) return;
    if (!allowedConversionEvents.includes(conversionEvent[0])) setConversionEvent([]);
  }, [metaObjective, allowedConversionEvents, conversionEvent.join(",")]);

  const currentValues = (): PromotionObjectiveValues => ({
    objective: objective[0] ?? "sales",
    metaObjective,
    conversionEvent: conversionEvent[0],
    dailyBudgetCents,
    platforms,
    locations: locationNames,
    // Both were held in state and never reported out, so Business Type and Promotion Type were
    // decorative: changing either altered nothing about the campaign that got built.
    businessType: businessType[0] ?? "solution_service",
    promotionType: promotionType[0] ?? "long_term",
  });

  // Keep the parent in step with every selection. Depends on the primitive/joined values rather
  // than the object so it fires on real changes only, not on each render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    onChangeRef.current?.(currentValues());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objective.join(","), metaObjective, conversionEvent.join(","), dailyBudgetCents, platforms.join(","), locationNames.join(","), businessType.join(","), promotionType.join(",")]);

  function handleGenerate() {
    onGenerate?.(currentValues());
  }

  return (
    <section className="gen-card">
      <div className="gen-card-header">
        <span className="gen-card-icon gen-card-icon-purple">
          <TargetIcon />
        </span>
        <h2>Promotion Objective</h2>
      </div>
      <div className="gen-fields-grid">
        <DropdownField label="Business Type" options={BUSINESS_TYPE_OPTIONS} selected={businessType} onChange={setBusinessType} />
        <DropdownField label="Your Business Goal" options={OBJECTIVE_OPTIONS} selected={objective} onChange={setObjective} recommendedValue="sales" />
        <DropdownField
          label="Your Ad Performance Goal"
          icon={<LightningIcon />}
          options={conversionEventOptions}
          selected={conversionEvent}
          onChange={setConversionEvent}
          placeholder="In-web actions"
        />
        <DropdownField
          label="Ad Platform"
          icon={<MetaInfinityIcon />}
          options={CHANNEL_OPTIONS}
          selected={channels}
          onChange={setChannels}
          multi
          testId="channel-select"
          recommendedValue="meta"
        />
        <DropdownField label="Target Locations" icon={<PinIcon />} options={COUNTRY_OPTIONS} selected={countries} onChange={(next) => { setCountriesTouched(true); setCountries(next); }} multi />
        <div className="gen-field">
          <span className="gen-field-label">Suggested Daily Limit</span>
          <div className="gen-field-control gen-field-budget">
            <input type="number" min="1" step="1" value={dailyBudget} onChange={(e) => { setBudgetTouched(true); setDailyBudget(e.target.value); }} />
            {/* The ad account's real billing currency, not a hardcoded "USD". This number becomes the
                campaign's daily budget, so mislabelling it misstates spend by the FX rate — on this
                INR account "50 USD" was really 50 rupees. */}
            <span className="gen-field-budget-unit">{currency}</span>
          </div>
        </div>
        <DropdownField label="Promotion Type" options={PROMOTION_TYPE_OPTIONS} selected={promotionType} onChange={setPromotionType} />
      </div>

      {simulation && (
        <div className="ncs-sim">
          <span className="ncs-sim-title">Ballpark projection — from your objective, budget &amp; platforms</span>
          <div className="ncs-sim-item"><span className="ncs-sim-val">{formatCompact(simulation.estImpressionsPerDay)}</span><span className="ncs-sim-key">impressions/day</span></div>
          <div className="ncs-sim-item"><span className="ncs-sim-val">{formatCompact(simulation.estClicks)}</span><span className="ncs-sim-key">clicks/day</span></div>
          <div className="ncs-sim-item"><span className="ncs-sim-val">{formatCompact(simulation.estConversions)}</span><span className="ncs-sim-key">conv./day</span></div>
          <div className="ncs-sim-item" title="A per-objective assumption based on a hypothetical average order value — it does not vary with budget."><span className="ncs-sim-val">{simulation.estRoas.toFixed(1)}×</span><span className="ncs-sim-key">assumed ROAS</span></div>
          <span className="ncs-sim-note">Rough industry estimate, adjusted for your target market — not a Meta forecast. Impressions, clicks and conversions scale with your budget; assumed ROAS does not (it reflects the objective and a hypothetical order value). Your selections are applied to the campaign when you generate.</span>
        </div>
      )}

      {onGenerate && (
        <button type="button" className="btn btn-primary gen-generate-btn" onClick={handleGenerate} disabled={generating}>
          {generating ? "Generating…" : <><span aria-hidden="true">✦</span> {generateLabel}</>}
        </button>
      )}
    </section>
  );
}
