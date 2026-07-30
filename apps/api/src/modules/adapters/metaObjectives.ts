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

/** Returns all objectives as an array for UI dropdowns. */
export function listObjectives(): Array<{ value: MetaCampaignObjective; label: string; description: string }> {
  return Object.entries(META_CAMPAIGN_OBJECTIVES).map(([key, val]) => ({
    value: key as MetaCampaignObjective,
    label: val.label,
    description: val.description,
  }));
}
