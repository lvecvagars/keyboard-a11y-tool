// Shared type definitions for keyboard-a11y-tool

// ---- Primitives ----

export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---- Module 1: Focus Traversal & Order Analysis ----

export interface TabStop {
  index: number;
  selector: string;
  tag: string;
  role: string | null;
  tabindex: number | null;
  /** Index in DOM source order (among all elements) */
  domOrder: number;
  boundingBox: BoundingBox;
  /** ms since traversal start */
  timestamp: number;
}

export interface TrapResult {
  isTrap: boolean;
  trappedElements: string[];
  escapeAttempts: EscapeAttempt[];
  location: string;
}

export interface EscapeAttempt {
  key: string;
  escaped: boolean;
}

export interface FocusOrderResult {
  /** Spearman rank correlation (−1 to 1) */
  correlationScore: number;
  violations: FocusOrderViolation[];
}

export interface FocusOrderViolation {
  fromElement: string;
  toElement: string;
  jumpDistance: number;
  direction: "backward-vertical" | "cross-boundary" | "other";
}

export interface SkipLinkResult {
  exists: boolean;
  targetReachable: boolean;
  targetSelector: string | null;
}

export interface ObscuredResult {
  fullyObscured: boolean;
  partiallyObscured: boolean;
  overlapPercent: number;
  obscuringElement: string | null;
  focusedInViewport: boolean;
  screenshotPath?: string;
}

export interface TraversalResult {
  forwardTabStops: TabStop[];
  backwardTabStops: TabStop[];
  traps: TrapResult[];
  focusOrder: FocusOrderResult;
  skipLink: SkipLinkResult;
  obscuredResults: Map<number, ObscuredResult>;
}

// ---- Module 2: Focus Indicator Visibility Analysis ----

export interface IndicatorExistence {
  hasVisibleChange: boolean;
  changedPixelCount: number;
  diffImagePath: string;
}

/**
 * "present"  — outline exists on focus
 * "replaced" — outline removed but compensated (boxShadow, border, etc.)
 * "removed"  — outline suppressed on focus, no replacement
 * "never"    — outline is none in both states
 */
export type OutlineState = "present" | "replaced" | "removed" | "never";

export interface CSSFocusStyle {
  outlineState: OutlineState;
  replacementProperties: string[];
  computedChanges: ComputedStyleChange[];
}

export interface ComputedStyleChange {
  property: string;
  unfocused: string;
  focused: string;
}

export interface IndicatorContrast {
  medianContrast: number;
  minContrast: number;
  percentMeeting3to1: number;
}

export interface IndicatorArea {
  qualifyingPixelCount: number;
  /** Per WCAG 2.4.13 formula, in device pixels */
  minimumRequiredArea: number;
  /** >=1.0 means pass */
  areaRatio: number;
  /** 0–1, how much of the perimeter the indicator covers */
  perimeterCoverage: number;
}

export interface VisibilityScore {
  score: number;
  level: "none" | "poor" | "partial" | "good" | "excellent";
  breakdown: {
    existence: IndicatorExistence;
    contrast: IndicatorContrast;
    area: IndicatorArea;
  };
}

export interface VisibilityResult {
  indicators: Map<number, {
    existence: IndicatorExistence;
    cssAnalysis: CSSFocusStyle;
    contrast: IndicatorContrast;
    area: IndicatorArea;
    score: VisibilityScore;
  }>;
}

// ---- Module 3: Interactive Element Coverage ----

export interface UnreachableElement {
  selector: string;
  tag: string;
  role: string | null;
  hasClickHandler: boolean;
  hasCursorPointer: boolean;
}

export interface CoverageGap {
  unreachableElements: UnreachableElement[];
  totalInteractive: number;
  totalReachable: number;
  coveragePercent: number;
}

export interface NonSemanticControl {
  selector: string;
  tag: string;
  hasTabindex: boolean;
  hasRole: boolean;
  hasKeyHandler: boolean;
  issues: string[];
}

export interface ScrollableRegion {
  selector: string;
  isFocusable: boolean;
  hasFocusableChild: boolean;
  scrollHeight: number;
  clientHeight: number;
}

export interface CoverageResult {
  coverageGap: CoverageGap;
  nonSemanticControls: NonSemanticControl[];
  scrollableRegions: ScrollableRegion[];
}

// ---- Final Report ----

export type Severity = "critical" | "warning" | "moderate" | "info";

export interface ReportIssue {
  checkId: string;
  wcagCriterion: string;
  severity: Severity;
  elementSelector: string;
  description: string;
  remediation: string;
  screenshotPath?: string;
}

export interface EvaluationReport {
  url: string;
  timestamp: string;
  durationMs: number;
  traversal: TraversalResult;
  visibility: VisibilityResult;
  coverage: CoverageResult;
  issues: ReportIssue[];
  summary: ReportSummary;
}

export interface ReportSummary {
  totalTabStops: number;
  totalIssues: number;
  criticalCount: number;
  warningCount: number;
  moderateCount: number;
  infoCount: number;
  averageVisibilityScore: number;
  keyboardCoveragePercent: number;
}