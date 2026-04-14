import {
  CRAFT_AFTER_ANSWERS_SYSTEM,
  CRAFT_INTERACTIVE_SYSTEM,
  streamCraftInteractive,
} from "../../lib/craft.js";

function sseWrite(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function normalizeBody(req) {
  const b = req.body;
  if (b == null) return {};
  if (typeof b === "string") {
    try {
      return JSON.parse(b);
    } catch {
      return {};
    }
  }
  if (typeof b === "object") return b;
  return {};
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = normalizeBody(req);
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
}
