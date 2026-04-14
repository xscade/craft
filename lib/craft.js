import OpenAI from "openai";

export const CRAFT_SYSTEM = `You convert user requests into a structured prompt using the CRAFT framework.

Output EXACTLY five lines in this form (square brackets and letters are required):
[C] <context: background about the user, situation, domain, constraints>
[R] <role: persona or expertise the assistant should adopt>
[A] <action: the specific task to perform>
[F] <format: structure, length, bullets, tables, deliverables>
[T] <tone or target audience: style, reading level, voice>

Fidelity (critical):
- Preserve the user's substance: channel or medium (e.g. Instagram post), brand or product names, dates they stated, audience, visual elements (logos, uniforms, scene, demographics), and any constraints. Weave those into the five lines instead of replacing them with a generic template.
- Do not invent concrete facts the user did not give (no made-up times, venues, durations, prices, or policies). If something is unspecified, omit it or say it is not specified—never fabricate to sound complete.
- [C] should carry the richest summary of their real ask so nothing important is lost; other lines support that same ask.

Rules:
- Only infer minor stylistic details when the user is genuinely vague; never drop or contradict what they already specified.
- Each line must start with [C], [R], [A], [F], or [T] followed by a space.
- No other preamble, title, or markdown fences—only those five lines.
- Keep each segment concise but specific enough to be useful.`;

/** First turn: either ask targeted questions (streamed) or emit final CRAFT. */
export const CRAFT_INTERACTIVE_SYSTEM = `You help users produce a structured CRAFT prompt (Context, Role, Action, Format, Tone).

Your entire reply MUST begin with exactly one line (uppercase, no leading spaces):
MODE: QUESTIONS
or
MODE: CRAFT

If you choose MODE: QUESTIONS (only when important details are missing and cannot be reasonably inferred):
- After that first line, write 1–4 short questions the user can answer.
- Put each question on its own line, starting with "- " (hyphen + space).
- Do not ask questions you could infer from what they already said.

If you choose MODE: CRAFT (when you have enough to proceed):
- After the first line, output EXACTLY five lines, nothing else:
[C] ...
[R] ...
[A] ...
[F] ...
[T] ...
- Each of those lines starts with [C], [R], [A], [F], or [T] followed by a space.
- No markdown fences, no numbering, no preamble after MODE: CRAFT.

Fidelity for MODE: CRAFT (critical):
- Preserve the user's substance: medium or channel (e.g. Instagram creative), names (school, brand), dates they gave, audience, visual/scene requirements (logo, uniforms, who appears in the image), and constraints. Reflect those across the five lines—do not replace their ask with a generic flyer or email template.
- Do not invent facts they did not state (no made-up time, venue, duration, price). If unknown, omit or say "not specified"—never fabricate.
- [C] should hold the richest faithful summary of their real request so nothing important is dropped.`;

/** After the user answered clarifying questions — final CRAFT only. */
export const CRAFT_AFTER_ANSWERS_SYSTEM = `The user answered your clarifying questions about their request.

Reply with:
First line: MODE: CRAFT
Then EXACTLY five lines:
[C] ...
[R] ...
[A] ...
[F] ...
[T] ...

Do not ask more questions. Infer only minor gaps from their answers—never contradict or drop what they (or their earlier message) already specified.

Fidelity (critical): keep channel/medium, names, dates, visual and audience details, and constraints from the original ask plus their answers. Do not invent times, venues, or other concrete facts they did not provide. [C] should carry the fullest faithful summary. No markdown fences.`;

function modelId() {
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

function missingKeyError() {
  return {
    ok: false,
    status: 503,
    error:
      "OPENAI_API_KEY is not set. For local dev, use .env. On Vercel, add it under Project → Settings → Environment Variables.",
  };
}

/**
 * @param {string} block
 * @returns {boolean}
 */
export function isValidCraftBlock(block) {
  const lines = block
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length !== 5) return false;
  const tags = ["[C]", "[R]", "[A]", "[F]", "[T]"];
  return lines.every((line, i) => line.startsWith(`${tags[i]} `));
}

/**
 * @param {string} fullText
 * @returns {{ mode: "craft"; craft: string } | { mode: "questions"; questions: string[] } | { mode: "error"; error: string }}
 */
export function parseInteractiveOutput(fullText) {
  const t = fullText.trim();
  if (!t) return { mode: "error", error: "Empty response from model." };

  const firstNl = t.indexOf("\n");
  const firstLine = (firstNl === -1 ? t : t.slice(0, firstNl)).trim();
  const rest = firstNl === -1 ? "" : t.slice(firstNl + 1).trim();

  const modeMatch = firstLine.match(/^MODE:\s*(QUESTIONS|CRAFT)\s*$/i);
  if (!modeMatch) {
    if (t.startsWith("[C] ") || /^\[C\]/.test(t.trim())) {
      const craft = t.replace(/^MODE:\s*CRAFT\s*\n?/i, "").trim();
      if (isValidCraftBlock(craft)) return { mode: "craft", craft };
    }
    return {
      mode: "error",
      error:
        "Unexpected model format (expected MODE: QUESTIONS or MODE: CRAFT on line 1). Try again or rephrase your request.",
    };
  }

  const kind = modeMatch[1].toUpperCase();
  if (kind === "QUESTIONS") {
    const questions = rest
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("-"))
      .map((l) => l.replace(/^-\s*/, "").trim())
      .filter(Boolean);
    if (questions.length === 0 && rest) {
      return { mode: "questions", questions: [rest] };
    }
    if (questions.length === 0) {
      return { mode: "error", error: "Model asked for context but did not include questions." };
    }
    return { mode: "questions", questions };
  }

  const craft = rest.trim();
  if (!isValidCraftBlock(craft)) {
    return {
      mode: "error",
      error: "CRAFT block is missing or does not have five [C]/[R]/[A]/[F]/[T] lines.",
    };
  }
  return { mode: "craft", craft };
}

/**
 * @param {{ role: string; content: string }[]} messages
 * @param {(delta: string, accumulated: string) => void} [onDelta]
 * @returns {Promise<{ ok: true, model: string } & ReturnType<typeof parseInteractiveOutput> | { ok: false, status: number, error: string }>}
 */
export async function streamCraftInteractive(messages, onDelta) {
  if (!process.env.OPENAI_API_KEY) {
    return missingKeyError();
  }

  const model = modelId();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let full = "";

  try {
    const stream = await client.chat.completions.create({
      model,
      temperature: 0.35,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const d = chunk.choices[0]?.delta?.content ?? "";
      if (d) {
        full += d;
        onDelta?.(d, full);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Request failed";
    const status = typeof err?.status === "number" ? err.status : 502;
    return { ok: false, status, error: message };
  }

  const parsed = parseInteractiveOutput(full);
  if (parsed.mode === "error") {
    return { ok: false, status: 422, error: parsed.error };
  }
  return { ok: true, model, ...parsed };
}

/**
 * @param {string} raw
 * @returns {Promise<{ ok: true, craft: string, model: string } | { ok: false, status: number, error: string }>}
 */
export async function runCraft(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return { ok: false, status: 400, error: "Missing prompt" };
  }
  if (!process.env.OPENAI_API_KEY) {
    return missingKeyError();
  }

  const model = modelId();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.4,
      messages: [
        { role: "system", content: CRAFT_SYSTEM },
        { role: "user", content: trimmed },
      ],
    });
    const text = completion.choices[0]?.message?.content?.trim() ?? "";
    if (!text) {
      return { ok: false, status: 502, error: "Empty response from model" };
    }
    return { ok: true, craft: text, model };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Request failed";
    const status = typeof err?.status === "number" ? err.status : 502;
    return { ok: false, status, error: message };
  }
}
