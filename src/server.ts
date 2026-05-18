import express from "express";
import * as path from "path";
import { runEvaluation } from "./evaluate";
import { lv } from "./i18n/lv";

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/output", express.static(path.join(__dirname, "..", "output")));

// Only one evaluation at a time (Playwright is resource-heavy)
let isRunning = false;

app.post("/api/evaluate", async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: lv.errors.missingUrl });
    return;
  }

  if (isRunning) {
    res.status(409).json({ error: lv.errors.evaluationAlreadyRunning });
    return;
  }

  // SSE: keep connection open and push progress messages as they come
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  function sendEvent(type: string, payload: Record<string, unknown>) {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  }

  isRunning = true;

  try {
    const result = await runEvaluation(url, (message) => {
      sendEvent("progress", { message });
    });

    sendEvent("complete", {
      message: "Evaluation complete",
      htmlReportUrl: "/" + result.htmlPath.replace(/\\/g, "/"),
      jsonReportUrl: "/" + result.jsonPath.replace(/\\/g, "/"),
      summary: result.report.summary,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendEvent("error", { message: lv.errors.evaluationFailed(message) });
  } finally {
    isRunning = false;
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Keyboard A11y Tool — web UI ready at http://localhost:${PORT}`);
});