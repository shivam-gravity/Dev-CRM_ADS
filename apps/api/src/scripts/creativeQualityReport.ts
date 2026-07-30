/**
 * Score stored SVG ad creatives against the design contract the generation prompt itself demands
 * (see vectorAdImageService.VECTOR_AD_TOOL: exact dimensions, a headline >= 56px, a filled
 * rounded-rect CTA, a wordmark, an 8% safe zone, a tight palette, and no unsafe constructs).
 *
 * WHY: choosing a cheaper model for creative generation was otherwise a judgement call resting on
 * SVG BYTE SIZE, which measures verbosity, not quality. These checks are deterministic and derived
 * from the prompt's own stated requirements, so two models can be compared on whether they actually
 * satisfy the brief rather than on how much markup they emit.
 *
 *   node dist/scripts/creativeQualityReport.js <campaignIdPrefix> [<campaignIdPrefix> ...]
 *
 * Deliberately NOT a pass/fail gate on publishing: visual appeal is not reducible to these numbers.
 * It is a comparison instrument, and the limitations are printed with the output.
 */
import { PrismaClient } from "@prisma/client";
import { objectStorage } from "../infra/objectStorage.js";

const SAFE_ZONE_FRACTION = 0.08;

interface Score {
  asset: string;
  bytes: number;
  width: number | null;
  height: number | null;
  viewBoxOk: boolean;
  textCount: number;
  maxFontPx: number;
  headlineLegible: boolean;
  ctaButton: boolean;
  gradients: number;
  distinctFills: number;
  elements: number;
  outsideSafeZone: number;
  safeZoneChecked: number;
  unsafe: string[];
}

function attr(svg: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(svg);
  return m ? m[1] : null;
}

function scoreSvg(assetUrl: string, svg: string): Score {
  const width = Number(attr(svg, "width")) || null;
  const height = Number(attr(svg, "height")) || null;
  const viewBox = attr(svg, "viewBox");
  const viewBoxOk = Boolean(viewBox && width && height && viewBox.trim() === `0 0 ${width} ${height}`);

  const texts = svg.match(/<text\b[\s\S]*?<\/text>/gi) ?? [];
  // font-size may be an attribute or inline style; collect both.
  const fontSizes = [...svg.matchAll(/font-size\s*[:=]\s*"?([\d.]+)/gi)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
  const maxFontPx = fontSizes.length ? Math.max(...fontSizes) : 0;

  // The brief asks for the CTA as a FILLED ROUNDED RECT — so a rect carrying both rx and fill.
  const ctaButton = /<rect\b[^>]*\brx\s*=\s*"[^"]+"[^>]*\bfill\s*=\s*"[^"]*"/i.test(svg) || /<rect\b[^>]*\bfill\s*=\s*"[^"]*"[^>]*\brx\s*=\s*"[^"]+"/i.test(svg);

  const gradients = (svg.match(/<linearGradient\b/gi) ?? []).length + (svg.match(/<radialGradient\b/gi) ?? []).length;
  const distinctFills = new Set(
    [...svg.matchAll(/fill\s*=\s*"(#[0-9a-f]{3,8})"/gi)].map((m) => m[1].toLowerCase())
  ).size;
  const elements = (svg.match(/<(?!\/|\?|!)[a-z]/gi) ?? []).length;

  // Safe-zone check on RAW x/y. A text node inside <g transform="translate(...)"> has coordinates
  // relative to that group, so scoring it raw yields FALSE POSITIVES as readily as false negatives —
  // the first version of this check claimed to only under-report, which was wrong. Transformed text
  // is therefore SKIPPED and counted separately, so the ratio is honest about what it actually saw.
  let outsideSafeZone = 0;
  let safeZoneChecked = 0;
  const transformedRanges: Array<[number, number]> = [];
  for (const m of svg.matchAll(/<g[^>]*transform\s*=\s*"[^"]*"[^>]*>/gi)) {
    // Approximate the group's extent as "from here to its closing tag or end of document".
    const start = m.index ?? 0;
    const close = svg.indexOf("</g>", start);
    transformedRanges.push([start, close === -1 ? svg.length : close]);
  }
  const isTransformed = (idx: number) => transformedRanges.some(([a, b]) => idx >= a && idx <= b);
  if (width && height) {
    const minX = width * SAFE_ZONE_FRACTION;
    const maxX = width * (1 - SAFE_ZONE_FRACTION);
    const minY = height * SAFE_ZONE_FRACTION;
    const maxY = height * (1 - SAFE_ZONE_FRACTION);
    for (const m of svg.matchAll(/<text[\s\S]*?<\/text>/gi)) {
      if (isTransformed(m.index ?? 0)) continue; // relative coords — not comparable to the safe zone
      const t = m[0];
      const x = Number(attr(t, "x"));
      const y = Number(attr(t, "y"));
      if (!Number.isFinite(x) && !Number.isFinite(y)) continue;
      safeZoneChecked += 1;
      if (Number.isFinite(x) && (x < minX || x > maxX)) outsideSafeZone += 1;
      else if (Number.isFinite(y) && (y < minY || y > maxY)) outsideSafeZone += 1;
    }
  }

  const unsafe: string[] = [];
  if (/<script\b/i.test(svg)) unsafe.push("script");
  if (/\son[a-z]+\s*=/i.test(svg)) unsafe.push("event-handler");
  if (/<image\b/i.test(svg)) unsafe.push("image");
  if (/(?:xlink:)?href\s*=\s*"(?!#)/i.test(svg)) unsafe.push("external-ref");

  return {
    asset: assetUrl.split("/").pop() ?? assetUrl,
    bytes: Buffer.byteLength(svg, "utf8"),
    width,
    height,
    viewBoxOk,
    textCount: texts.length,
    maxFontPx,
    headlineLegible: maxFontPx >= 56,
    ctaButton,
    gradients,
    distinctFills,
    elements,
    outsideSafeZone,
    safeZoneChecked,
    unsafe,
  };
}

function avg(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function main(): Promise<void> {
  const prefixes = process.argv.slice(2);
  if (prefixes.length === 0) {
    console.log("usage: node dist/scripts/creativeQualityReport.js <campaignIdPrefix> [...]");
    return;
  }
  const prisma = new PrismaClient();
  try {
    for (const prefix of prefixes) {
      const campaign = await prisma.campaign.findFirst({ where: { id: { startsWith: prefix } } });
      if (!campaign) {
        console.log(`\n${prefix}: campaign not found`);
        continue;
      }
      const data = campaign.data as any;
      const assets = (data.creativeAssets ?? []).filter((a: any) => a.type === "image");
      const scores: Score[] = [];
      for (const asset of assets) {
        const key = String(asset.url).replace(/^\/objects\//, "");
        const buf = await objectStorage.get(key);
        if (!buf) continue;
        scores.push(scoreSvg(asset.url, buf.toString("utf8")));
      }

      console.log(`\n═══ ${prefix} — ${JSON.stringify(data.name)} — ${scores.length} creative(s) ═══`);
      console.log(
        `  ${"asset".padEnd(14)} ${"bytes".padStart(7)} ${"dims".padStart(11)} ${"vbOk".padStart(5)} ${"texts".padStart(6)} ${"maxFont".padStart(8)} ${"legible".padStart(8)} ${"cta".padStart(4)} ${"grads".padStart(6)} ${"fills".padStart(6)} ${"elems".padStart(6)} ${"offzone".padStart(8)} unsafe`
      );
      for (const s of scores) {
        console.log(
          `  ${s.asset.slice(0, 13).padEnd(14)} ${String(s.bytes).padStart(7)} ${`${s.width}x${s.height}`.padStart(11)} ${String(s.viewBoxOk).padStart(5)} ${String(s.textCount).padStart(6)} ${String(s.maxFontPx).padStart(8)} ${String(s.headlineLegible).padStart(8)} ${String(s.ctaButton).padStart(4)} ${String(s.gradients).padStart(6)} ${String(s.distinctFills).padStart(6)} ${String(s.elements).padStart(6)} ${`${s.outsideSafeZone}/${s.safeZoneChecked}`.padStart(8)} ${s.unsafe.join(",") || "-"}`
        );
      }
      if (scores.length) {
        console.log(
          `  AVG            ${String(Math.round(avg(scores.map((s) => s.bytes)))).padStart(7)} ` +
            `${"".padStart(11)} ${String(scores.filter((s) => s.viewBoxOk).length + "/" + scores.length).padStart(5)} ` +
            `${avg(scores.map((s) => s.textCount)).toFixed(1).padStart(6)} ${avg(scores.map((s) => s.maxFontPx)).toFixed(0).padStart(8)} ` +
            `${String(scores.filter((s) => s.headlineLegible).length + "/" + scores.length).padStart(8)} ` +
            `${String(scores.filter((s) => s.ctaButton).length + "/" + scores.length).padStart(4)} ` +
            `${avg(scores.map((s) => s.gradients)).toFixed(1).padStart(6)} ${avg(scores.map((s) => s.distinctFills)).toFixed(1).padStart(6)} ` +
            `${avg(scores.map((s) => s.elements)).toFixed(0).padStart(6)} ${`${scores.reduce((a, s) => a + s.outsideSafeZone, 0)}/${scores.reduce((a, s) => a + s.safeZoneChecked, 0)}`.padStart(8)}`
        );
      }
    }
    console.log(
      "\nLimitations: `offzone` shows outside/checked and scores ONLY untransformed text. In practice these\n" +
        "models place all text inside <g transform> groups, so it reads 0/0 — meaning NOT MEASURED, not\n" +
        "compliant. (An earlier version scored raw coordinates and reported 11-15 violations per creative\n" +
        "that were ALL false positives.) Resolving transforms would need a real SVG layout pass.\n" +
        "`fills` counts distinct hex fills only (gradient stops and named colours are excluded).\n" +
        "None of this measures visual appeal — it measures whether the model met the brief it was given."
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
