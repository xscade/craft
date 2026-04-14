const promptEl = document.getElementById("prompt");
const outputEl = document.getElementById("output");
const convertBtn = document.getElementById("convert");
const copyBtn = document.getElementById("copy");
const statusEl = document.getElementById("status");
const streamWrap = document.getElementById("stream-wrap");
const streamPreview = document.getElementById("stream-preview");
const clarifyPanel = document.getElementById("clarify-panel");
const questionList = document.getElementById("question-list");
const answersEl = document.getElementById("answers");
const submitAnswersBtn = document.getElementById("submit-answers");
const cancelClarifyBtn = document.getElementById("cancel-clarify");

/** @type {{ initialPrompt: string; questions: string[] | null }} */
const session = {
  initialPrompt: "",
  questions: null,
};

/** Exact CRAFT string last received from the API (avoids DOM/selection quirks when copying). */
let craftClipboardSource = "";

/**
 * @param {string} text
 * @returns {Promise<boolean>}
 */
/**
 * CRAFT lines → plain prompt for pasting elsewhere (no [C]/[R]/… prefixes).
 * Drops junk lines like a bare "[C][R][A][F][T]".
 * @param {string} craft
 * @returns {string}
 */
function craftToPlainClipboard(craft) {
  const lines = craft.trim().split(/\r?\n/);
  const parts = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const compact = line.replace(/\s+/g, "");
    if (compact === "[C][R][A][F][T]") continue;
    if (/^(\[C\]|\[R\]|\[A\]|\[F\]|\[T\])+$/.test(compact)) continue;
    const m = line.match(/^\[(C|R|A|F|T)\]\s+(.*)$/);
    if (m) {
      const body = m[2].trim();
      if (body) parts.push(body);
    }
  }
  return parts.join("\n\n");
}

async function copyTextToClipboard(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function showStreamPreview(show) {
  streamWrap.classList.toggle("hidden", !show);
  if (!show) streamPreview.textContent = "";
}

function hideClarifyPanel() {
  clarifyPanel.classList.add("hidden");
  questionList.innerHTML = "";
  answersEl.value = "";
  session.questions = null;
}

function resetSessionUi() {
  hideClarifyPanel();
  showStreamPreview(false);
  session.initialPrompt = "";
}

/**
 * @param {Response} response
 * @param {{ onDelta?: (t: string) => void; onFinal?: (o: Record<string, unknown>) => void; onError?: (o: { error?: string }) => void }} hooks
 */
async function consumeSse(response, hooks) {
  const reader = response.body?.getReader();
  if (!reader) {
    hooks.onError?.({ error: "No response body" });
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    for (;;) {
      const sep = buffer.indexOf("\n\n");
      if (sep === -1) break;
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      let eventName = "message";
      const dataLines = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      const dataStr = dataLines.join("\n");
      let data = {};
      if (dataStr) {
        try {
          data = JSON.parse(dataStr);
        } catch {
          data = {};
        }
      }

      if (eventName === "delta" && typeof data.text === "string") {
        hooks.onDelta?.(data.text);
      } else if (eventName === "final") {
        hooks.onFinal?.(data);
      } else if (eventName === "error") {
        hooks.onError?.(data);
      }
    }
  }
}

async function runStream(body, { isFollowup }) {
  craftClipboardSource = "";
  outputEl.textContent = "";
  copyBtn.disabled = true;
  convertBtn.disabled = true;
  submitAnswersBtn.disabled = true;
  showStreamPreview(true);
  streamPreview.textContent = "";
  setStatus(isFollowup ? "Generating CRAFT from your answers…" : "Thinking (streamed)…");

  let acc = "";
  try {
    const res = await fetch("/api/craft/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      setStatus(errJson.error || `Error (${res.status})`, true);
      showStreamPreview(false);
      return;
    }

    await consumeSse(res, {
      onDelta: (t) => {
        acc += t;
        streamPreview.textContent = acc;
        streamPreview.scrollTop = streamPreview.scrollHeight;
      },
      onFinal: (data) => {
        if (data.mode === "craft" && typeof data.craft === "string") {
          showStreamPreview(false);
          hideClarifyPanel();
          craftClipboardSource = data.craft;
          outputEl.textContent = data.craft;
          copyBtn.disabled = false;
          setStatus(data.model ? `Done · ${data.model}` : "Done");
        } else if (data.mode === "questions" && Array.isArray(data.questions)) {
          session.questions = data.questions;
          showStreamPreview(false);
          questionList.innerHTML = "";
          for (const q of data.questions) {
            const li = document.createElement("li");
            li.textContent = q;
            questionList.appendChild(li);
          }
          clarifyPanel.classList.remove("hidden");
          answersEl.focus();
          setStatus(data.model ? `Needs context · ${data.model}` : "Answer the questions below");
        } else {
          setStatus("Unexpected response from server.", true);
          showStreamPreview(false);
        }
      },
      onError: (data) => {
        setStatus(data.error || "Stream error", true);
        showStreamPreview(false);
      },
    });
  } catch {
    setStatus("Network error. Is the server running?", true);
  } finally {
    convertBtn.disabled = false;
    submitAnswersBtn.disabled = false;
  }
}

async function convert() {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    setStatus("Enter a prompt first.", true);
    return;
  }

  resetSessionUi();
  session.initialPrompt = prompt;
  await runStream({ prompt, phase: "initial" }, { isFollowup: false });
}

async function submitAnswers() {
  const answers = answersEl.value.trim();
  if (!session.initialPrompt) {
    setStatus("Start with a prompt first.", true);
    return;
  }
  if (!session.questions?.length) {
    setStatus("No pending questions.", true);
    return;
  }
  if (!answers) {
    setStatus("Add your answers before generating CRAFT.", true);
    return;
  }

  clarifyPanel.classList.add("hidden");
  await runStream(
    {
      phase: "followup",
      initialPrompt: session.initialPrompt,
      questions: session.questions,
      answers,
    },
    { isFollowup: true },
  );
}

function cancelClarify() {
  resetSessionUi();
  setStatus("Cleared. Adjust your prompt and convert again.");
}

async function copyOutput() {
  const text = craftClipboardSource || outputEl.textContent || "";
  if (!text.trim()) return;
  const plain = craftToPlainClipboard(text);
  if (!plain.trim()) {
    setStatus("Nothing to copy after removing CRAFT tags.", true);
    return;
  }
  const ok = await copyTextToClipboard(plain);
  if (ok) setStatus("Copied plain prompt (no [C]–[T] tags)");
  else setStatus("Could not copy", true);
}

convertBtn.addEventListener("click", convert);
copyBtn.addEventListener("click", copyOutput);
submitAnswersBtn.addEventListener("click", submitAnswers);
cancelClarifyBtn.addEventListener("click", cancelClarify);

promptEl.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    convert();
  }
});
