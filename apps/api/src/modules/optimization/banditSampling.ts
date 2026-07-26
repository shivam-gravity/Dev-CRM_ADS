/**
 * Bayesian multi-armed-bandit sampling for the optimization engine. Models each ad variant's true
 * conversion rate as a Beta posterior and uses Thompson sampling to choose which arm to exploit —
 * a principled replacement for the old epsilon-greedy Math.random() coin-flip. High-uncertainty
 * arms (little data → wide posterior) get explored; proven arms (tight posterior) get exploited,
 * with no hand-tuned exploration constant to drift.
 *
 * The RNG is injectable on every entry point so callers (and tests) can pass a seeded generator
 * for deterministic behavior; it defaults to Math.random in production.
 */

export type Rng = () => number;

/** Standard normal N(0,1) via the Box–Muller transform. */
function sampleNormal(rng: Rng): number {
  // Guard u1 away from 0 so log() never sees 0 → -Infinity.
  const u1 = Math.max(rng(), Number.MIN_VALUE);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Gamma(shape, scale=1) via Marsaglia–Tsang — O(1) per draw regardless of shape, so it stays cheap
 * even when a variant has tens of thousands of clicks (a sum-of-exponentials Gamma would loop per
 * click). The shape<1 branch (boosting) is defensive: our α,β are always ≥ 1 in practice.
 */
function sampleGamma(shape: number, rng: Rng): number {
  if (shape < 1) return sampleGamma(shape + 1, rng) * Math.pow(Math.max(rng(), Number.MIN_VALUE), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Rejection loop: expected iterations < 1.05, so this terminates quickly.
  for (;;) {
    const x = sampleNormal(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = rng();
    const x2 = x * x;
    if (u < 1 - 0.0331 * x2 * x2) return d * v;
    if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Draw one sample from Beta(alpha, beta) as X / (X + Y) with X ~ Gamma(alpha), Y ~ Gamma(beta).
 * Both shape params must be > 0.
 */
export function sampleBeta(alpha: number, beta: number, rng: Rng = Math.random): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  const total = x + y;
  return total > 0 ? x / total : 0.5;
}

export interface BanditArm {
  id: string;
  /** Observed successes (conversions). */
  successes: number;
  /** Observed failures (non-converting clicks). */
  failures: number;
}

/**
 * Thompson sampling over arms with known success/failure counts. Models each arm as a Beta
 * posterior with a uniform Beta(1,1) prior (α = successes + 1, β = failures + 1), draws one sample
 * per arm, and returns the id of the arm with the highest draw. Returns null for an empty arm set.
 */
export function thompsonPick(arms: BanditArm[], rng: Rng = Math.random): string | null {
  let bestId: string | null = null;
  let bestDraw = -Infinity;
  for (const arm of arms) {
    const draw = sampleBeta(arm.successes + 1, Math.max(arm.failures, 0) + 1, rng);
    if (draw > bestDraw) {
      bestDraw = draw;
      bestId = arm.id;
    }
  }
  return bestId;
}
