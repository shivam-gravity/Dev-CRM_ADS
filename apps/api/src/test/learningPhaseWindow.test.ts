import { test } from "node:test";
import assert from "node:assert";
import { conversionsInTrailingWindow } from "../modules/pipeline/performancePipeline.js";
import type { PerformanceMetric } from "../types/index.js";

function metric(variantId: string, date: string, conversions: number): PerformanceMetric {
  return {
    id: `${variantId}-${date}`,
    campaignId: "c1",
    variantId,
    network: "meta",
    date,
    impressions: 1000,
    reach: 900,
    clicks: 50,
    conversions,
    spendCents: 5000,
    revenueCents: 10000,
  };
}

test("conversionsInTrailingWindow sums only rows within the window", () => {
  const today = "2026-07-25";
  const metrics: PerformanceMetric[] = [
    metric("v1", "2026-07-25", 10), // today — in
    metric("v1", "2026-07-20", 15), // 5 days ago — in (7-day window = 2026-07-19..25)
    metric("v1", "2026-07-19", 100), // far window edge — in
    metric("v1", "2026-07-18", 999), // just outside the window — excluded
    metric("v2", "2026-07-24", 3),
  ];

  const result = conversionsInTrailingWindow(metrics, 7, today);
  assert.strictEqual(result.get("v1"), 125, "v1 sums the in-window rows (10 + 15 + 100), excluding only the 07-18 row");
  assert.strictEqual(result.get("v2"), 3);
});

test("conversionsInTrailingWindow includes the far edge day and excludes the day before it", () => {
  const today = "2026-07-25";
  const metrics: PerformanceMetric[] = [
    metric("v1", "2026-07-19", 7), // exactly windowDays-1 days back — included
    metric("v1", "2026-07-18", 5), // one day earlier — excluded
  ];
  const result = conversionsInTrailingWindow(metrics, 7, today);
  assert.strictEqual(result.get("v1"), 7);
});

test("conversionsInTrailingWindow ignores unparseable dates", () => {
  const today = "2026-07-25";
  const metrics: PerformanceMetric[] = [metric("v1", "not-a-date", 50), metric("v1", "2026-07-25", 4)];
  const result = conversionsInTrailingWindow(metrics, 7, today);
  assert.strictEqual(result.get("v1"), 4);
});
