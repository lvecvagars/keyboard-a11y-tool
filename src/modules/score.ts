/**
 * M2-05: Quantitative Visibility Score
 *
 * Combines M2-01 (existence), M2-03 (contrast), and M2-04 (area)
 * into a single 0–100 composite score per element.
 *
 * Band placement:
 *   0        = No visible change (M2-01 failed)
 *   1–30     = Some change, fails both contrast AND area
 *   31–60    = Meets either contrast OR area, but not both
 *   61–90    = Meets both contrast AND area minimums
 *   91–100   = Exceeds WCAG 2.4.13 with strong contrast and generous area
 *
 * Within each band, the score interpolates based on how strong the
 * individual metrics are — not just whether they pass or fail.
 */

import { IndicatorExistence, IndicatorContrast, IndicatorArea, VisibilityScore } from "../types";

/** Contrast ratio threshold per WCAG 2.4.13 */
const CONTRAST_PASS = 3;

/** Area ratio threshold (qualifying pixels / minimum required) */
const AREA_PASS = 1.0;

/**
 * Thresholds for the "excellent" band (91–100).
 * These represent generous indicators that clearly exceed minimums.
 */
const EXCELLENT_CONTRAST = 4.5;
const EXCELLENT_AREA_RATIO = 2.0;
const EXCELLENT_PERIMETER = 0.9;

/**
 * Compute the M2-05 visibility score for a single element.
 */
export function computeVisibilityScore(
  existence: IndicatorExistence,
  contrast: IndicatorContrast,
  area: IndicatorArea
): VisibilityScore {
  // Band 0: No visible change at all
  if (!existence.hasVisibleChange) {
    return {
      score: 0,
      level: "none",
      breakdown: { existence, contrast, area },
    };
  }

  const contrastPasses = contrast.medianContrast >= CONTRAST_PASS;
  const areaPasses = area.areaRatio >= AREA_PASS;

  let score: number;
  let level: VisibilityScore["level"];

  if (!contrastPasses && !areaPasses) {
    // Band 1–30: Fails both
    score = computeBandScore(1, 30, contrast, area);
    level = "poor";
  } else if (contrastPasses && areaPasses) {
    // Check for excellent (91–100) vs good (61–90)
    const isExcellent =
      contrast.medianContrast >= EXCELLENT_CONTRAST &&
      area.areaRatio >= EXCELLENT_AREA_RATIO &&
      area.perimeterCoverage >= EXCELLENT_PERIMETER;

    if (isExcellent) {
      score = computeExcellentScore(contrast, area);
      level = "excellent";
    } else {
      score = computeBandScore(61, 90, contrast, area);
      level = "good";
    }
  } else {
    // Band 31–60: Meets one but not the other
    score = computeBandScore(31, 60, contrast, area);
    level = "partial";
  }

  return {
    score,
    level,
    breakdown: { existence, contrast, area },
  };
}

/**
 * Interpolate within a band based on metric strength.
 *
 * Uses three sub-factors, each contributing equally:
 *   1. Contrast strength: how close medianContrast is to 3:1 (or above)
 *   2. Area coverage: how close areaRatio is to 1.0 (or above)
 *   3. Perimeter coverage: how complete the indicator wraps the element
 *
 * Each factor is normalized to 0–1, then mapped into the band range.
 */
function computeBandScore(
  bandMin: number,
  bandMax: number,
  contrast: IndicatorContrast,
  area: IndicatorArea
): number {
  // Contrast factor: 1:1 → 0, 3:1 → 1, cap at 1
  const contrastFactor = Math.min(
    (contrast.medianContrast - 1) / (CONTRAST_PASS - 1),
    1
  );

  // Area factor: 0 → 0, 1.0 → 1, cap at 1
  const areaFactor = Math.min(area.areaRatio, 1);

  // Perimeter factor: 0 → 0, 1 → 1
  const perimeterFactor = area.perimeterCoverage;

  // Weighted average — contrast and area are the WCAG criteria,
  // perimeter is supplementary
  const combined =
    contrastFactor * 0.4 +
    areaFactor * 0.4 +
    perimeterFactor * 0.2;

  const score = bandMin + combined * (bandMax - bandMin);
  return Math.round(score);
}

/**
 * Score within the excellent band (91–100).
 * All three excellent thresholds are already met to reach here.
 * Interpolate based on how far above the excellent thresholds we are.
 */
function computeExcellentScore(
  contrast: IndicatorContrast,
  area: IndicatorArea
): number {
  // How far above excellent thresholds (diminishing returns)
  const contrastBonus = Math.min(
    (contrast.medianContrast - EXCELLENT_CONTRAST) / EXCELLENT_CONTRAST,
    1
  );
  const areaBonus = Math.min(
    (area.areaRatio - EXCELLENT_AREA_RATIO) / EXCELLENT_AREA_RATIO,
    1
  );
  const perimeterBonus = Math.min(
    (area.perimeterCoverage - EXCELLENT_PERIMETER) / (1 - EXCELLENT_PERIMETER),
    1
  );

  const combined =
    contrastBonus * 0.4 +
    areaBonus * 0.4 +
    perimeterBonus * 0.2;

  return Math.round(91 + combined * 9);
}