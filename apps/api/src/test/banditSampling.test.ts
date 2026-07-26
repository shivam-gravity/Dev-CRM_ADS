import { test } from "node:test";
import assert from "node:assert";
import { sampleBeta, thompsonPick, type BanditArm, type Rng } from "../modules/optimization/banditSampling.js";

/** A tiny deterministic LCG so these tests never depend on Math.random. */
function seededRng(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test("sampleBeta stays within [0,1] across many draws", () => {
  const rng = seededRng(42);
  for (let i = 0; i < 2000; i++) {
    const x = sampleBeta(3, 7, rng);
    assert.ok(x >= 0 && x <= 1, `Beta draw ${x} out of [0,1]`);
  }
});

test("sampleBeta mean approximates alpha/(alpha+beta)", () => {
  const rng = seededRng(7);
  const alpha = 8;
  const beta = 2;
  let sum = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) sum += sampleBeta(alpha, beta, rng);
  const mean = sum / n;
  const expected = alpha / (alpha + beta); // 0.8
  assert.ok(Math.abs(mean - expected) < 0.02, `Beta(${alpha},${beta}) mean ${mean.toFixed(3)} ≈ ${expected}`);
});

test("thompsonPick overwhelmingly favors the clearly-better arm over many trials", () => {
  const arms: BanditArm[] = [
    { id: "strong", successes: 80, failures: 20 }, // ~80% conversion
    { id: "weak", successes: 20, failures: 80 },   // ~20% conversion
  ];
  const rng = seededRng(123);
  let strongWins = 0;
  const trials = 1000;
  for (let i = 0; i < trials; i++) {
    if (thompsonPick(arms, rng) === "strong") strongWins++;
  }
  // With this separation the strong arm should win essentially always.
  assert.ok(strongWins > trials * 0.95, `strong arm won ${strongWins}/${trials} — expected >95%`);
});

test("thompsonPick still explores an uncertain arm — a zero-data arm can win", () => {
  const arms: BanditArm[] = [
    { id: "known", successes: 6, failures: 4 },  // 60%, but modest sample
    { id: "unseen", successes: 0, failures: 0 }, // no data → uniform posterior, wide uncertainty
  ];
  const rng = seededRng(999);
  let unseenWins = 0;
  const trials = 1000;
  for (let i = 0; i < trials; i++) {
    if (thompsonPick(arms, rng) === "unseen") unseenWins++;
  }
  // The unseen arm should win a meaningful share (exploration), but not dominate the 60% arm.
  assert.ok(unseenWins > trials * 0.15 && unseenWins < trials * 0.85, `unseen arm won ${unseenWins}/${trials} — expected genuine-but-not-dominant exploration`);
});

test("thompsonPick returns null for no arms", () => {
  assert.strictEqual(thompsonPick([], seededRng(1)), null);
});
