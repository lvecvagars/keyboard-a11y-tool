// M2-05: Composite visibility score (0–100)
//
// Bands:
//   0        = No visible change (M2-01 failed)
//   1–30     = Fails both contrast AND area
//   31–60    = Meets either contrast OR area, not both
//   61–90    = Meets both
//   91–100   = Exceeds minimums (contrast ≥ 4.5:1, area ≥ 2x, perimeter ≥ 0.9)

import { IndicatorExistence, IndicatorContrast, IndicatorArea, VisibilityScore } from "../types";

const CONTRAST_PASS = 3;
const AREA_PASS = 1.0;

const EXCELLENT_CONTRAST = 4.5;
const EXCELLENT_AREA_RATIO = 2.0;
const EXCELLENT_PERIMETER = 0.9;

export function computeVisibilityScore(
  existence: IndicatorExistence,
  contrast: IndicatorContrast,
  area: IndicatorArea
): VisibilityScore {
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
    score = computeBandScore(1, 30, contrast, area);
    level = "poor";
  } else if (contrastPasses && areaPasses) {
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
    score = computeBandScore(31, 60, contrast, area);
    level = "partial";
  }

  return {
    score,
    level,
    breakdown: { existence, contrast, area },
  };
}

// Interpolation within a band using three sub-factors:
// contrast strength (40%), area coverage (40%), perimeter (20%)
function computeBandScore(
  bandMin: number,
  bandMax: number,
  contrast: IndicatorContrast,
  area: IndicatorArea
): number {
  const contrastFactor = Math.min(
    (contrast.medianContrast - 1) / (CONTRAST_PASS - 1),
    1
  );
  const areaFactor = Math.min(area.areaRatio, 1);
  const perimeterFactor = area.perimeterCoverage;

  const combined =
    contrastFactor * 0.4 +
    areaFactor * 0.4 +
    perimeterFactor * 0.2;

  const score = bandMin + combined * (bandMax - bandMin);
  return Math.round(score);
}

function computeExcellentScore(
  contrast: IndicatorContrast,
  area: IndicatorArea
): number {
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