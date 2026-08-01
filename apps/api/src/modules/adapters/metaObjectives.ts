/**
 * Meta's current campaign objectives (post-ODAX migration, v22.0+).
 * The old objectives (LINK_CLICKS, CONVERSIONS, etc.) are deprecated.
 */
export const META_CAMPAIGN_OBJECTIVES = {
  OUTCOME_AWARENESS: {
    label: "Awareness",
    description: "Maximize reach and brand recall",
    optimizationGoals: ["REACH", "AD_RECALL_LIFT", "IMPRESSIONS"],
    defaultOptimizationGoal: "REACH",
  },
  OUTCOME_TRAFFIC: {
    label: "Traffic",
    description: "Send people to a destination (website, app, Messenger)",
    optimizationGoals: ["LINK_CLICKS", "LANDING_PAGE_VIEWS", "REACH", "IMPRESSIONS"],
    defaultOptimizationGoal: "LINK_CLICKS",
  },
  OUTCOME_ENGAGEMENT: {
    label: "Engagement",
    description: "Get more messages, video views, post engagement, or page likes",
    optimizationGoals: ["POST_ENGAGEMENT", "PAGE_LIKES", "EVENT_RESPONSES", "THRUPLAY"],
    defaultOptimizationGoal: "POST_ENGAGEMENT",
  },
  OUTCOME_LEADS: {
    label: "Leads",
    description: "Collect leads via forms, Messenger, or calls",
    optimizationGoals: ["LEAD_GENERATION", "CONVERSATIONS", "LINK_CLICKS"],
    defaultOptimizationGoal: "LEAD_GENERATION",
  },
  OUTCOME_APP_PROMOTION: {
    label: "App Promotion",
    description: "Drive app installs or in-app events",
    optimizationGoals: ["APP_INSTALLS", "OFFSITE_CONVERSIONS", "LINK_CLICKS"],
    defaultOptimizationGoal: "APP_INSTALLS",
  },
  OUTCOME_SALES: {
    label: "Sales",
    description: "Find people likely to purchase your product or service",
    optimizationGoals: ["OFFSITE_CONVERSIONS", "VALUE", "LINK_CLICKS", "LANDING_PAGE_VIEWS"],
    defaultOptimizationGoal: "OFFSITE_CONVERSIONS",
  },
} as const;

export type MetaCampaignObjective = keyof typeof META_CAMPAIGN_OBJECTIVES;

/**
 * Which pixel conversion events (promoted_object.custom_event_type) Meta accepts for a given
 * objective. A mismatched pair is rejected at AD SET creation with "Conversion event unavailable:
 * This conversion event isn't available with the objective that you selected."
 *
 * Nothing modelled this, so the two funnels could be crossed freely. Observed live on the Polluxa
 * account, both directions, every variant failed:
 *   OUTCOME_LEADS + PURCHASE  (C-0013 — builder defaults the event to PURCHASE, goal was Leads)
 *   OUTCOME_SALES + LEAD
 * Both had already created their campaign container by then, so each left an empty campaign shell
 * orphaned in the ad account.
 *
 * Only the two conversion objectives are constrained. Objectives absent from this map are treated
 * as unconstrained on purpose rather than by omission: OUTCOME_TRAFFIC with a pixel + PURCHASE
 * publishes fine on this same account, so listing it here would reject a configuration that
 * demonstrably works. Shared events (COMPLETE_REGISTRATION, SUBSCRIBE, START_TRIAL, DONATE,
 * CONTENT_VIEW, SEARCH) genuinely belong to both funnels.
 */
export const CONVERSION_EVENTS_BY_OBJECTIVE: Partial<Record<MetaCampaignObjective, readonly string[]>> = {
  OUTCOME_SALES: [
    "PURCHASE", "ADD_TO_CART", "INITIATED_CHECKOUT", "ADD_PAYMENT_INFO", "ADD_TO_WISHLIST",
    "COMPLETE_REGISTRATION", "CONTENT_VIEW", "SEARCH", "SUBSCRIBE", "START_TRIAL", "DONATE", "OTHER",
  ],
  OUTCOME_LEADS: [
    "LEAD", "COMPLETE_REGISTRATION", "SUBMIT_APPLICATION", "SCHEDULE", "CONTACT", "FIND_LOCATION",
    "CONTENT_VIEW", "SEARCH", "SUBSCRIBE", "START_TRIAL", "DONATE", "OTHER",
  ],
};

/**
 * Events Meta accepts for this objective, or null when the objective is unconstrained (see above).
 * Callers that build a picker should fall back to their full list on null.
 */
export function listConversionEventsForObjective(objective: string): readonly string[] | null {
  if (!isValidObjective(objective)) return null;
  return CONVERSION_EVENTS_BY_OBJECTIVE[objective] ?? null;
}

/** The event a picker should land on for an objective — first entry is the canonical one. */
export function defaultConversionEventForObjective(objective: string): string | undefined {
  return listConversionEventsForObjective(objective)?.[0];
}

/** False only when the objective is constrained AND the event is not in its list. */
export function isConversionEventValidForObjective(objective: string, conversionEvent: string): boolean {
  const allowed = listConversionEventsForObjective(objective);
  if (!allowed) return true;
  return allowed.includes(normalizeConversionEvent(conversionEvent));
}

/**
 * Graph API custom_event_type is an uppercase enum, but the pickers do not agree on case — the
 * wizard's PromotionObjectiveCard sends "purchase" while CampaignBuilder sends "PURCHASE". Normalise
 * at the write boundary so a campaign can never be persisted with a value Meta would reject on
 * spelling alone, and so the objective check below compares like with like.
 */
export function normalizeConversionEvent(conversionEvent: string): string {
  return conversionEvent.trim().toUpperCase();
}

/**
 * The actionable message for a crossed objective/event pair, or null when the pair is fine.
 *
 * Single source of the wording for all three boundaries that check it (campaign generation, the
 * builder's PATCH, and the launch guard) so a user who somehow reaches the later one is not told
 * something different from the earlier one.
 */
export function conversionEventMismatchError(objective: string, conversionEvent: string): string | null {
  if (isConversionEventValidForObjective(objective, conversionEvent)) return null;
  const allowed = listConversionEventsForObjective(objective) ?? [];
  const label = isValidObjective(objective) ? ` (${getObjectiveLabel(objective)})` : "";
  return (
    `Conversion event ${normalizeConversionEvent(conversionEvent)} is not available for objective ${objective}${label} — ` +
    `Meta rejects this pairing when the ad set is created. Choose one of: ${allowed.join(", ")}.`
  );
}

/** Returns the best optimization_goal for an ad set given the campaign objective and whether a pixel is present. */
export function resolveOptimizationGoal(objective: MetaCampaignObjective, hasPixel: boolean): string {
  if (objective === "OUTCOME_SALES" || objective === "OUTCOME_LEADS") {
    // Conversion optimization (OFFSITE_CONVERSIONS) REQUIRES a promoted object (pixel + event);
    // without one Meta rejects the ad set with "Select a promoted object" (subcode 1815430).
    // The default goal for these objectives IS OFFSITE_CONVERSIONS, so we must degrade explicitly
    // when there's no pixel — optimize for landing-page views, which needs no promoted object and
    // is the closest lower-funnel proxy. With a pixel, use conversions as intended.
    return hasPixel ? "OFFSITE_CONVERSIONS" : "LANDING_PAGE_VIEWS";
  }
  return META_CAMPAIGN_OBJECTIVES[objective].defaultOptimizationGoal;
}

/** Validates that a given string is a valid Meta campaign objective. */
export function isValidObjective(value: string): value is MetaCampaignObjective {
  return value in META_CAMPAIGN_OBJECTIVES;
}

/** Short human label for an objective ("OUTCOME_TRAFFIC" -> "Traffic"), for campaign names and UI copy. */
export function getObjectiveLabel(objective: MetaCampaignObjective): string {
  return META_CAMPAIGN_OBJECTIVES[objective].label;
}

/**
 * Returns all objectives as an array for UI dropdowns.
 *
 * `conversionEvents` ships with each objective so a conversion-event picker can filter itself to
 * the pairs Meta will actually accept, instead of the web keeping its own copy of the funnel rules
 * and drifting from the guard in campaignOrchestrator. null = unconstrained (show the full list).
 */
export function listObjectives(): Array<{
  value: MetaCampaignObjective;
  label: string;
  description: string;
  conversionEvents: readonly string[] | null;
}> {
  return Object.entries(META_CAMPAIGN_OBJECTIVES).map(([key, val]) => ({
    value: key as MetaCampaignObjective,
    label: val.label,
    description: val.description,
    conversionEvents: CONVERSION_EVENTS_BY_OBJECTIVE[key as MetaCampaignObjective] ?? null,
  }));
}
