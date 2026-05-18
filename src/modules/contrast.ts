// M2-03 + M2-04: Contrast and area calculations for focus indicators

import { PNG } from "pngjs";
import { IndicatorContrast, IndicatorArea } from "../types";

// WCAG relative luminance:
//   L = 0.2126 * R' + 0.7152 * G' + 0.0722 * B'
// where R' = (R/255 <= 0.04045) ? R/255/12.92 : ((R/255 + 0.055)/1.055)^2.4

function sRGBtoLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * sRGBtoLinear(r) +
    0.7152 * sRGBtoLinear(g) +
    0.0722 * sRGBtoLinear(b)
  );
}

function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Per-channel threshold to filter out sub-pixel rendering noise.
// 10/255 (~4%) is low enough to catch subtle indicators but high
// enough to skip anti-aliasing artifacts.
const PIXEL_CHANGE_THRESHOLD = 10;

const CONTRAST_THRESHOLD = 3; // WCAG 2.4.13

interface PixelAnalysis {
  contrastValues: number[];
  qualifyingPixels: { x: number; y: number }[];
}

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
 * Compute both contrast and area in a single pixel pass (avoids looping twice).
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

// WCAG 2.4.13 minimum area: 2px perimeter around the element.
// Formula: 2 * (W + H) * 2 in CSS pixels, then scaled to device pixels.
function computeMinimumArea(
  elementWidth: number,
  elementHeight: number,
  devicePixelRatio: number
): number {
  const cssArea = 2 * (elementWidth + elementHeight) * 2;
  return Math.round(cssArea * devicePixelRatio * devicePixelRatio);
}

// Perimeter coverage: divide the element's perimeter into ~4px segments,
// check each for nearby qualifying pixels within a tolerance band.
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

  const padDev = Math.round(padding * devicePixelRatio);
  const elW = Math.round(elementWidth * devicePixelRatio);
  const elH = Math.round(elementHeight * devicePixelRatio);

  const elLeft = padDev;
  const elTop = padDev;
  const elRight = elLeft + elW;
  const elBottom = elTop + elH;

  const segmentSize = 4;
  const tolerance = Math.round(6 * devicePixelRatio);

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

  const pixelSet = new Set<string>();
  for (const p of qualifyingPixels) {
    pixelSet.add(`${p.x},${p.y}`);
  }

  let coveredSegments = 0;
  for (const point of perimeterPoints) {
    let found = false;
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