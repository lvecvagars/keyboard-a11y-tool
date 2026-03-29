// ============================================================
// Shared type definitions for keyboard-a11y-tool
// Based on the Detection Scope Specification (13 checks, 3 modules)
// ============================================================

// ---- Primitives ----

/** Bounding box of an element in viewport coordinates (CSS pixels) */
export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---- Module 1: Focus Traversal & Order Analysis ----

/** M1-01: A single tab stop recorded during traversal */
export interface TabStop {
  /** Position in the tab sequence (0-based) */
  index: number;
  /** Unique CSS selector for the element */
  selector: string;
  /** HTML tag name (lowercase, e.g. "a", "button", "div") */
  tag: string;
  /** ARIA role — explicit role attribute, or implicit role from tag */
  role: string | null;
  /** The element's tabindex attribute value, or null if not set */
  tabindex: number | null;
  /** Index of this element in DOM source order (among all elements) */
  domOrder: number;
  /** Bounding box in the viewport at the time of focus */
  boundingBox: BoundingBox;
  /** Timestamp (ms since traversal start) when this stop was recorded */
  timestamp: number;
}

/** M1-02: Result of keyboard trap detection at a specific location */
export interface TrapResult {
  isTrap: boolean;
  /** Selectors of the elements that form the trapped cycle */
  trappedElements: string[];
  /** Which escape keys were tried and whether they worked */
  escapeAttempts: EscapeAttempt[];
  /** Selector of the element where the trap was first detected */
  location: string;
}

export interface EscapeAttempt {
  key: string;
  escaped: boolean;
}

/** M1-03: Focus order vs. visual layout analysis */
export interface FocusOrderResult {
  /** Spearman rank correlation between visual order and tab order (−1 to 1) */
  correlationScore: number;
  /** Individual cases where focus jumps unexpectedly */
  violations: FocusOrderViolation[];
}

export interface FocusOrderViolation {
  fromElement: string;
  toElement: string;
  /** Distance of the jump in CSS pixels */
  jumpDistance: number;
  /** Direction of the jump relative to reading order */
  direction: "backward-vertical" | "cross-boundary" | "other";
}

/** M1-04: Skip link verification */
export interface SkipLinkResult {
  exists: boolean;
  /** Whether activating the skip link actually moved focus to the target */
  targetReachable: boolean;
  /** Selector of the skip link's target element, if found */
  targetSelector: string | null;
}

/** M1-05: Focus not obscured detection (per tab stop) */
export interface ObscuredResult {
  /** The focused element is completely hidden behind a fixed/sticky element */
  fullyObscured: boolean;
  /** The focused element is partially overlapped */
  partiallyObscured: boolean;
  /** Percentage of the focused element's area that is covered (0–100) */
  overlapPercent: number;
  /** Selector of the element doing the obscuring, if any */
  obscuringElement: string | null;
  /** Whether the focused element is within the viewport at all */
  focusedInViewport: boolean;
}

/** Combined output of Module 1 */
export interface TraversalResult {
  /** M1-01: All tab stops in forward order */
  forwardTabStops: TabStop[];
  /** M1-01: All tab stops in backward (Shift+Tab) order */
  backwardTabStops: TabStop[];
  /** M1-02: Any keyboard traps detected */
  traps: TrapResult[];
  /** M1-03: Focus order analysis */
  focusOrder: FocusOrderResult;
  /** M1-04: Skip link check */
  skipLink: SkipLinkResult;
  /** M1-05: Obscured status for each tab stop (keyed by tab stop index) */
  obscuredResults: Map<number, ObscuredResult>;
}

// ---- Module 2: Focus Indicator Visibility Analysis ----

/** M2-01: Does a visible focus indicator exist? (screenshot diff) */
export interface IndicatorExistence {
  /** Whether the screenshot diff showed a meaningful visual change */
  hasVisibleChange: boolean;
  /** Number of pixels that changed between focused and unfocused states */
  changedPixelCount: number;
  /** File path to the saved diff image */
  diffImagePath: string;
}

/** M2-02: CSS focus style analysis */
export interface CSSFocusStyle {
  /** Whether outline: none / outline: 0 was found without a replacement */
  outlineRemoved: boolean;
  /** CSS properties that changed to compensate (e.g. boxShadow, border) */
  replacementProperties: string[];
  /** Raw computed style differences between focused and unfocused states */
  computedChanges: ComputedStyleChange[];
}

export interface ComputedStyleChange {
  property: string;
  unfocused: string;
  focused: string;
}

/** M2-03: Focus indicator contrast ratio */
export interface IndicatorContrast {
  /** Median contrast ratio across all changed pixels */
  medianContrast: number;
  /** Minimum contrast ratio found */
  minContrast: number;
  /** Percentage of changed pixels that meet the 3:1 threshold */
  percentMeeting3to1: number;
}

/** M2-04: Focus indicator area measurement */
export interface IndicatorArea {
  /** Total changed pixels that meet 3:1 contrast */
  qualifyingPixelCount: number;
  /** Minimum required area per WCAG 2.4.13 formula (in device pixels) */
  minimumRequiredArea: number;
  /** Ratio of qualifying pixels to minimum required (>=1.0 = pass) */
  areaRatio: number;
  /** How much of the element's perimeter the indicator covers (0–1) */
  perimeterCoverage: number;
}

/** M2-05: Composite visibility score for one element */
export interface VisibilityScore {
  /** 0–100 composite score */
  score: number;
  /** Human-readable level derived from the score */
  level: "none" | "poor" | "partial" | "good" | "excellent";
  /** Sub-scores that feed into the composite */
  breakdown: {
    existence: IndicatorExistence;
    contrast: IndicatorContrast;
    area: IndicatorArea;
  };
}

/** Combined output of Module 2 (one entry per tab stop) */
export interface VisibilityResult {
  /** Keyed by tab stop index */
  indicators: Map<number, {
    existence: IndicatorExistence;
    cssAnalysis: CSSFocusStyle;
    contrast: IndicatorContrast;
    area: IndicatorArea;
    score: VisibilityScore;
  }>;
}

// ---- Module 3: Interactive Element Coverage ----

/** M3-01: An interactive element that keyboard can't reach */
export interface UnreachableElement {
  selector: string;
  tag: string;
  role: string | null;
  hasClickHandler: boolean;
  hasCursorPointer: boolean;
}

/** M3-01: Gap between pointer-interactive and keyboard-reachable sets */
export interface CoverageGap {
  unreachableElements: UnreachableElement[];
  /** Total count of elements identified as pointer-interactive */
  totalInteractive: number;
  /** Total count of elements that received keyboard focus */
  totalReachable: number;
  /** Percentage of interactive elements that are keyboard-reachable */
  coveragePercent: number;
}

/** M3-02: A non-semantic element used as an interactive control */
export interface NonSemanticControl {
  selector: string;
  tag: string;
  hasTabindex: boolean;
  hasRole: boolean;
  hasKeyHandler: boolean;
  /** Specific issues found (e.g. "missing tabindex", "no keyboard handler") */
  issues: string[];
}

/** M3-03: A scrollable region and its keyboard accessibility */
export interface ScrollableRegion {
  selector: string;
  /** Whether the scrollable container itself is focusable */
  isFocusable: boolean;
  /** Whether it contains at least one focusable child */
  hasFocusableChild: boolean;
  scrollHeight: number;
  clientHeight: number;
}

/** Combined output of Module 3 */
export interface CoverageResult {
  /** M3-01 */
  coverageGap: CoverageGap;
  /** M3-02 */
  nonSemanticControls: NonSemanticControl[];
  /** M3-03 */
  scrollableRegions: ScrollableRegion[];
}

// ---- Final Report ----

/** Severity levels for individual findings */
export type Severity = "critical" | "warning" | "moderate" | "info";

/** A single issue in the final report */
export interface ReportIssue {
  /** Which check produced this (e.g. "M1-02", "M2-01") */
  checkId: string;
  /** WCAG success criterion (e.g. "2.1.2", "2.4.7") */
  wcagCriterion: string;
  severity: Severity;
  /** Selector of the affected element */
  elementSelector: string;
  /** Human-readable description of the problem */
  description: string;
  /** Suggested fix */
  remediation: string;
  /** Path to a screenshot illustrating the issue, if available */
  screenshotPath?: string;
}

/** Top-level report structure */
export interface EvaluationReport {
  /** URL that was evaluated */
  url: string;
  /** ISO 8601 timestamp of when the evaluation started */
  timestamp: string;
  /** Total time the evaluation took (ms) */
  durationMs: number;
  /** Raw results from each module */
  traversal: TraversalResult;
  visibility: VisibilityResult;
  coverage: CoverageResult;
  /** Flattened list of all issues found, across all modules */
  issues: ReportIssue[];
  /** Summary statistics */
  summary: ReportSummary;
}

export interface ReportSummary {
  totalTabStops: number;
  totalIssues: number;
  criticalCount: number;
  warningCount: number;
  moderateCount: number;
  infoCount: number;
  /** Average visibility score across all tab stops (0–100) */
  averageVisibilityScore: number;
  /** Keyboard coverage percentage from M3-01 */
  keyboardCoveragePercent: number;
}