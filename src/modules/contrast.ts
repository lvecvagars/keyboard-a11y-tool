/**
 * M2-03: Focus Indicator Contrast Ratio
 * M2-04: Focus Indicator Area Measurement
 *
 * Shared WCAG luminance math used by both checks.
 *
 * WCAG relative luminance formula:
 *   L = 0.2126 * R' + 0.7152 * G' + 0.0722 * B'
 *   where R' = (R/255 <= 0.04045) ? R/255/12.92 : ((R/255 + 0.055)/1.055)^2.4
 *
 * Contrast ratio:
 *   (L1 + 0.05) / (L2 + 0.05)  where L1 >= L2
 */

import { PNG } from "pngjs";
import { IndicatorContrast, IndicatorArea } from "../types";

/**
 * Convert an 8-bit sRGB channel value (0–255) to linear light.
 * This is the inverse of the sRGB transfer function.
 */
function sRGBtoLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * Compute WCAG relative luminance for an RGB color.
 * Returns a value between 0 (black) and 1 (white).
 */
function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * sRGBtoLinear(r) +
    0.7152 * sRGBtoLinear(g) +
    0.0722 * sRGBtoLinear(b)
  );
}

/**
 * Compute the WCAG contrast ratio between two luminance values.
 * Always returns a value >= 1.0 (identical colors = 1.0, black vs white = 21.0).
 */
function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Minimum per-channel difference (in any of R, G, B) to consider a pixel
 * as "changed" between focused and unfocused states. This filters out
 * sub-pixel rendering noise and anti-aliasing artifacts that don't
 * represent the actual focus indicator.
 *
 * A threshold of 10 means a pixel must differ by at least 10/255 (~4%)
 * in at least one channel. This is intentionally low — we want to catch
 * subtle indicators — but high enough to skip anti-aliasing noise.
 */
const PIXEL_CHANGE_THRESHOLD = 10;

/** Contrast threshold per WCAG 2.4.13 for qualifying indicator pixels */
const CONTRAST_THRESHOLD = 3;

/**
 * Per-pixel analysis result: whether the pixel changed, and if so,
 * its contrast ratio and position. Used by both M2-03 and M2-04.
 */
interface PixelAnalysis {
  /** Contrast ratios of all changed pixels (for M2-03 median/min) */
  contrastValues: number[];
  /** Positions of pixels that are both changed AND meet 3:1 (for M2-04 area/perimeter) */
  qualifyingPixels: { x: number; y: number }[];
}

/**
 * Analyze every pixel in the focused/unfocused pair.
 * Shared between M2-03 and M2-04 so we only loop once.
 */
function analyzePixels(focusedPng: PNG, unfocusedPng: PNG): PixelAnalysis {
  const { width, height } = focusedPng;
  const contrastValues: number[] = [];
  const qualifyingPixels: { x: number; y: number }[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;

      const fR = focusedPng.data[idx];
      const fG = focusedPng.data[idx + 1];
      const fB = focusedPng.data[idx + 2];

      const uR = unfocusedPng.data[idx];
      const uG = unfocusedPng.data[idx + 1];
      const uB = unfocusedPng.data[idx + 2];

      const dR = Math.abs(fR - uR);
      const dG = Math.abs(fG - uG);
      const dB = Math.abs(fB - uB);

      if (dR < PIXEL_CHANGE_THRESHOLD &&
          dG < PIXEL_CHANGE_THRESHOLD &&
          dB < PIXEL_CHANGE_THRESHOLD) {
        continue;
      }

      const fLum = relativeLuminance(fR, fG, fB);
      const uLum = relativeLuminance(uR, uG, uB);
      const cr = contrastRatio(fLum, uLum);

      contrastValues.push(cr);

      if (cr >= CONTRAST_THRESHOLD) {
        qualifyingPixels.push({ x, y });
      }
    }
  }

  return { contrastValues, qualifyingPixels };
}

/**
 * M2-03: Compute contrast metrics from the pixel analysis.
 *
 * @param focusedPng        - Screenshot with focus indicator visible
 * @param unfocusedPng      - Screenshot without focus indicator
 * @param changedPixelCount - From pixelmatch (quick zero-check only)
 * @returns IndicatorContrast with median, min, and percentage meeting 3:1
 */
export function computeContrastFromDiff(
  focusedPng: PNG,
  unfocusedPng: PNG,
  changedPixelCount: number
): IndicatorContrast {
  if (changedPixelCount === 0) {
    return { medianContrast: 1, minContrast: 1, percentMeeting3to1: 0 };
  }

  const { contrastValues } = analyzePixels(focusedPng, unfocusedPng);
  return contrastFromValues(contrastValues);
}

/**
 * M2-03 + M2-04: Compute both contrast and area metrics in a single pass.
 *
 * This is the preferred entry point — it avoids looping through pixels twice.
 *
 * @param focusedPng        - Screenshot with focus indicator visible
 * @param unfocusedPng      - Screenshot without focus indicator
 * @param changedPixelCount - From pixelmatch (quick zero-check only)
 * @param elementWidth      - Element's CSS width in device pixels
 * @param elementHeight     - Element's CSS height in device pixels
 * @param padding           - Screenshot padding in CSS pixels (same as SCREENSHOT_PADDING)
 * @param devicePixelRatio  - Page's devicePixelRatio for CSS-to-device-pixel conversion
 */
export function computeContrastAndArea(
  focusedPng: PNG,
  unfocusedPng: PNG,
  changedPixelCount: number,
  elementWidth: number,
  elementHeight: number,
  padding: number,
  devicePixelRatio: number
): { contrast: IndicatorContrast; area: IndicatorArea } {
  if (changedPixelCount === 0) {
    const minArea = computeMinimumArea(elementWidth, elementHeight, devicePixelRatio);
    return {
      contrast: { medianContrast: 1, minContrast: 1, percentMeeting3to1: 0 },
      area: {
        qualifyingPixelCount: 0,
        minimumRequiredArea: minArea,
        areaRatio: 0,
        perimeterCoverage: 0,
      },
    };
  }

  const { contrastValues, qualifyingPixels } = analyzePixels(focusedPng, unfocusedPng);
  const contrast = contrastFromValues(contrastValues);
  const area = computeArea(
    qualifyingPixels,
    elementWidth,
    elementHeight,
    padding,
    devicePixelRatio,
    focusedPng.width,
    focusedPng.height
  );

  return { contrast, area };
}

/**
 * Compute IndicatorContrast from a sorted list of contrast values.
 */
function contrastFromValues(contrastValues: number[]): IndicatorContrast {
  if (contrastValues.length === 0) {
    return { medianContrast: 1, minContrast: 1, percentMeeting3to1: 0 };
  }

  contrastValues.sort((a, b) => a - b);

  const n = contrastValues.length;
  const medianContrast =
    n % 2 === 1
      ? contrastValues[Math.floor(n / 2)]
      : (contrastValues[n / 2 - 1] + contrastValues[n / 2]) / 2;

  const minContrast = contrastValues[0];
  const meetingThreshold = contrastValues.filter((cr) => cr >= CONTRAST_THRESHOLD).length;
  const percentMeeting3to1 = Math.round((meetingThreshold / n) * 100);

  return {
    medianContrast: Math.round(medianContrast * 100) / 100,
    minContrast: Math.round(minContrast * 100) / 100,
    percentMeeting3to1,
  };
}

/**
 * WCAG 2.4.13 minimum required area: a 2px perimeter around the element.
 *
 * Formula: 2 × (width + height) × 2  (in CSS pixels)
 * We convert to device pixels since our screenshots are in device pixels.
 *
 * The formula represents: perimeter length × 2px thickness.
 * For a 100×50 element: 2 × (100+50) × 2 = 600 CSS pixels.
 */
function computeMinimumArea(
  elementWidth: number,
  elementHeight: number,
  devicePixelRatio: number
): number {
  const cssArea = 2 * (elementWidth + elementHeight) * 2;
  return Math.round(cssArea * devicePixelRatio * devicePixelRatio);
}

/**
 * M2-04: Compute area and perimeter coverage from qualifying pixels.
 *
 * Perimeter coverage measures what fraction of the element's perimeter
 * has qualifying pixels nearby. We divide the perimeter into segments
 * and check if each segment has at least one qualifying pixel within
 * a small distance.
 */
function computeArea(
  qualifyingPixels: { x: number; y: number }[],
  elementWidth: number,
  elementHeight: number,
  padding: number,
  devicePixelRatio: number,
  imgWidth: number,
  imgHeight: number
): IndicatorArea {
  const minimumRequiredArea = computeMinimumArea(elementWidth, elementHeight, devicePixelRatio);
  const qualifyingPixelCount = qualifyingPixels.length;
  const areaRatio = minimumRequiredArea > 0
    ? Math.round((qualifyingPixelCount / minimumRequiredArea) * 100) / 100
    : 0;

  // Compute perimeter coverage:
  // The element sits inside the screenshot at an offset of `padding` pixels
  // (in CSS pixels, scaled by devicePixelRatio for device pixels).
  const padDev = Math.round(padding * devicePixelRatio);
  const elW = Math.round(elementWidth * devicePixelRatio);
  const elH = Math.round(elementHeight * devicePixelRatio);

  // Element bounds within the screenshot image
  const elLeft = padDev;
  const elTop = padDev;
  const elRight = elLeft + elW;
  const elBottom = elTop + elH;

  // Divide the perimeter into segments of ~4 device pixels each.
  // For each segment, check if any qualifying pixel is within
  // a tolerance band around the element's edge.
  const segmentSize = 4;
  const tolerance = Math.round(6 * devicePixelRatio); // how far from the edge a pixel can be

  // Generate perimeter sample points (midpoint of each segment)
  const perimeterPoints: { x: number; y: number }[] = [];

  // Top edge
  for (let x = elLeft; x < elRight; x += segmentSize) {
    perimeterPoints.push({ x, y: elTop });
  }
  // Right edge
  for (let y = elTop; y < elBottom; y += segmentSize) {
    perimeterPoints.push({ x: elRight, y });
  }
  // Bottom edge
  for (let x = elLeft; x < elRight; x += segmentSize) {
    perimeterPoints.push({ x, y: elBottom });
  }
  // Left edge
  for (let y = elTop; y < elBottom; y += segmentSize) {
    perimeterPoints.push({ x: elLeft, y });
  }

  if (perimeterPoints.length === 0) {
    return { qualifyingPixelCount, minimumRequiredArea, areaRatio, perimeterCoverage: 0 };
  }

  // For each perimeter point, check if any qualifying pixel is nearby
  // Build a set of qualifying pixel positions for fast lookup
  const pixelSet = new Set<string>();
  for (const p of qualifyingPixels) {
    pixelSet.add(`${p.x},${p.y}`);
  }

  let coveredSegments = 0;
  for (const point of perimeterPoints) {
    let found = false;
    // Check a small area around this perimeter point
    for (let dy = -tolerance; dy <= tolerance && !found; dy++) {
      for (let dx = -tolerance; dx <= tolerance && !found; dx++) {
        const px = point.x + dx;
        const py = point.y + dy;
        if (px >= 0 && px < imgWidth && py >= 0 && py < imgHeight) {
          if (pixelSet.has(`${px},${py}`)) {
            found = true;
          }
        }
      }
    }
    if (found) coveredSegments++;
  }

  const perimeterCoverage = Math.round((coveredSegments / perimeterPoints.length) * 100) / 100;

  return { qualifyingPixelCount, minimumRequiredArea, areaRatio, perimeterCoverage };
}