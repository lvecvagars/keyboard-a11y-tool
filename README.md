# keyboard-a11y-tool

Automated keyboard accessibility evaluation tool for WCAG 2.2 compliance.  
Master's thesis, University of Latvia, 2026.

**Web app:** https://keyboard-a11y-tool-lv21095.up.railway.app

## Repository structure

```
src/
  index.ts              CLI entry point
  server.ts             Web interface (Express + SSE)
  batch.ts              Batch evaluation of multiple URLs
  evaluate.ts           Core pipeline: M1 → M2 → M3 → report
  types/index.ts        Shared type definitions (TabStop, ReportIssue, etc.)
  i18n/lv.ts            All user-facing strings (Latvian)
  modules/
    traversal.ts        Module 1: focus traversal, traps, skip link, obscured focus
    visibility.ts       Module 2: screenshot diff, CSS analysis, indicator detection
    contrast.ts         Module 2: WCAG luminance/contrast and area calculations
    score.ts            Module 2: composite visibility score (0–100)
    coverage.ts         Module 3: interactive element coverage, non-semantic controls
  reports/
    generator.ts        Issue generation, summary statistics, HTML/JSON report output
  utils/
    browser.ts          Playwright launch and navigation
    consent.ts          Cookie/consent modal dismissal

test/
  run-fixtures.ts       Automated fixture runner (validates all 15 test pages)
  fixtures/             15 HTML test pages, one per check (m0-clean-page.html … m3-03-*.html)

public/
  index.html            Web interface frontend

Dockerfile              Docker configuration (Playwright base image)
sites.txt               Example URL list for batch mode
```