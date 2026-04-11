/**
 * Web server for the keyboard accessibility evaluation tool.
 *
 * Endpoints:
 *   GET  /                → serves the frontend (public/index.html)
 *   POST /api/evaluate    → starts an evaluation, streams progress via SSE
 *   GET  /output/*        → serves generated report files (HTML, JSON, PNGs)
 */

import express from "express";
import * as path from "path";
import { runEvaluation } from "./evaluate";

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// ---- Middleware ----

// Parse JSON request bodies (for the POST endpoint)
app.use(express.json());

// Serve the frontend from public/
app.use(express.static(path.join(__dirname, "..", "public")));

// Serve generated reports (screenshots, HTML reports, etc.)
// The output/ directory is at the project root
app.use("/output", express.static(path.join(__dirname, "..", "output")));

// ---- Track running evaluations ----

// Only allow one evaluation at a time (Playwright is resource-heavy).
// A production tool might use a job queue, but for a thesis project
// this keeps things simple and prevents the server from running out
// of memory by launching multiple browser instances.
let isRunning = false;

// ---- API ----

app.post("/api/evaluate", async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Missing or invalid 'url' in request body" });
    return;
  }

  if (isRunning) {
    res.status(409).json({ error: "An evaluation is already running. Please wait." });
    return;
  }

  // ---- Set up SSE ----
  // Server-Sent Events: we keep the connection open and push text messages
  // to the browser as the evaluation progresses. The browser uses the
  // EventSource API to receive these.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Helper to send an SSE message.
  // SSE format: "data: <payload>\n\n"
  // We send JSON so the frontend can distinguish message types.
  function sendEvent(type: string, payload: Record<string, unknown>) {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  }

  isRunning = true;

  try {
    const result = await runEvaluation(url, (message) => {
      sendEvent("progress", { message });
    });

    // Send the final result — the frontend will use htmlPath to load the report
    sendEvent("complete", {
      message: "Evaluation complete",
      htmlReportUrl: "/" + result.htmlPath.replace(/\\/g, "/"),
      jsonReportUrl: "/" + result.jsonPath.replace(/\\/g, "/"),
      summary: result.report.summary,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendEvent("error", { message: `Evaluation failed: ${message}` });
  } finally {
    isRunning = false;
    res.end();
  }
});

// ---- Start ----

app.listen(PORT, () => {
  console.log(`Keyboard A11y Tool — web UI ready at http://localhost:${PORT}`);
});