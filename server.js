import dotenv from "dotenv";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  CRAFT_AFTER_ANSWERS_SYSTEM,
  CRAFT_INTERACTIVE_SYSTEM,
  runCraft,
  streamCraftInteractive,
} from "./lib/craft.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dotenv only loads `.env` by default; `.env.local` is common for secrets (Next/Vercel-style).
dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config({ path: path.join(__dirname, ".env.local") });
const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");

app.use(express.json({ limit: "64kb" }));

function sseWrite(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

app.post("/api/craft", async (req, res) => {
  const raw = typeof req.body?.prompt === "string" ? req.body.prompt : "";
  const result = await runCraft(raw);
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  return res.json({ craft: result.craft, model: result.model });
});

app.post("/api/craft/stream", async (req, res) => {
  const body = req.body || {};
  const phase = body.phase === "followup" ? "followup" : "initial";

  let messages;

  if (phase === "initial") {
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }
    messages = [
      { role: "system", content: CRAFT_INTERACTIVE_SYSTEM },
      { role: "user", content: prompt },
    ];
  } else {
    const initialPrompt =
      typeof body.initialPrompt === "string" ? body.initialPrompt.trim() : "";
    const answers = typeof body.answers === "string" ? body.answers.trim() : "";
    const questions = Array.isArray(body.questions)
      ? body.questions.filter((q) => typeof q === "string" && q.trim())
      : [];
    if (!initialPrompt || !answers || questions.length === 0) {
      return res.status(400).json({
        error: "Follow-up requires initialPrompt, answers, and a non-empty questions array.",
      });
    }
    const assistantBlock = `MODE: QUESTIONS\n${questions.map((q) => `- ${q.trim()}`).join("\n")}`;
    messages = [
      { role: "system", content: CRAFT_AFTER_ANSWERS_SYSTEM },
      { role: "user", content: initialPrompt },
      { role: "assistant", content: assistantBlock },
      { role: "user", content: `Here are my answers:\n${answers}` },
    ];
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error:
        "OPENAI_API_KEY is not set. For local dev, use .env. On Vercel, add it under Project → Settings → Environment Variables.",
    });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const result = await streamCraftInteractive(messages, (delta) => {
    sseWrite(res, "delta", { text: delta });
  });

  if (!result.ok) {
    sseWrite(res, "error", { error: result.error, status: result.status });
    res.end();
    return;
  }

  if (result.mode === "craft") {
    sseWrite(res, "final", { mode: "craft", craft: result.craft, model: result.model });
  } else {
    sseWrite(res, "final", {
      mode: "questions",
      questions: result.questions,
      model: result.model,
    });
  }
  res.end();
});

app.use(express.static(publicDir));

export default app;

if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => {
    console.log(`CRAFT converter at http://localhost:${PORT}`);
  });
  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use. Stop the other server (try: lsof -i :${PORT}) or run with PORT=3001 npm run dev`,
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
