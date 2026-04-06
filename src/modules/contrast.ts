/**
 * M2-03: Focus Indicator Contrast Ratio
 *
 * Analyzes the contrast between focused and unfocused pixel colors
 * for every pixel that changed between the two states.
 *
 * WCAG relative luminance formula:
 *   L = 0.2126 * R' + 0.7152 * G' + 0.0722 * B'
 *   where R' = (R/255 <= 0.04045) ? R/255/12.92 : ((R/255 + 0.055)/1.055)^2.4
 *
 * Contrast ratio:
 *   (L1 + 0.05) / (L2 + 0.05)  where L1 >= L2
 *
 * This file is kept separate from visibility.ts for clarity since the
 * WCAG luminance math is self-contained and reusable (M2-04 will also
 * need the 3:1 threshold to count qualifying pixels).
 */

import { PNG } from "pngjs";
import { IndicatorContrast } from "../types";

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

/**
 * Compute M2-03 contrast metrics by comparing the focused and unfocused PNGs.
 *
 * Rather than relying on pixelmatch's diff image (which uses its own
 * internal color coding and doesn't preserve original colors), we compare
 * the focused and unfocused screenshots directly. A pixel is considered
 * "changed" if any RGB channel differs by more than PIXEL_CHANGE_THRESHOLD.
 * For each changed pixel, we compute the WCAG contrast ratio between
 * its focused and unfocused colors.
 *
 * @param focusedPng        - Screenshot with focus indicator visible
 * @param unfocusedPng      - Screenshot without focus indicator
 * @param changedPixelCount - Number of changed pixels reported by pixelmatch
 *                            (used only as a quick zero-check)
 * @returns IndicatorContrast with median, min, and percentage meeting 3:1
 */
export function computeContrastFromDiff(
  focusedPng: PNG,
  unfocusedPng: PNG,
  changedPixelCount: number
): IndicatorContrast {
  // If pixelmatch reported no changes, skip the work
  if (changedPixelCount === 0) {
    return { medianContrast: 1, minContrast: 1, percentMeeting3to1: 0 };
  }

  const { width, height } = focusedPng;
  const contrastValues: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;

      const fR = focusedPng.data[idx];
      const fG = focusedPng.data[idx + 1];
      const fB = focusedPng.data[idx + 2];

      const uR = unfocusedPng.data[idx];
      const uG = unfocusedPng.data[idx + 1];
      const uB = unfocusedPng.data[idx + 2];

      // Check if this pixel changed enough to be part of the indicator
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
    }
  }

  if (contrastValues.length === 0) {
    return { medianContrast: 1, minContrast: 1, percentMeeting3to1: 0 };
  }

  // Sort for median calculation
  contrastValues.sort((a, b) => a - b);

  const n = contrastValues.length;
  const medianContrast =
    n % 2 === 1
      ? contrastValues[Math.floor(n / 2)]
      : (contrastValues[n / 2 - 1] + contrastValues[n / 2]) / 2;

  const minContrast = contrastValues[0];

  const meetingThreshold = contrastValues.filter((cr) => cr >= 3).length;
  const percentMeeting3to1 = Math.round((meetingThreshold / n) * 100);

  return {
    medianContrast: Math.round(medianContrast * 100) / 100,
    minContrast: Math.round(minContrast * 100) / 100,
    percentMeeting3to1,
  };
}