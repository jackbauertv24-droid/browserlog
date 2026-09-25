// ask.mjs — send one question to the ChatGPT tab and return the reply text,
// deciding completion with a CONFIDENCE MODEL over user-visible signals.
// Additive: talks only to browserlog's localhost control endpoint + reads the log.
//
// Why confidence, not a marker: ChatGPT's invisible identifiers rotate (SSE
// completion markers, hashed classes), but user-visible behaviour is stable — the
// Stop control shows while generating and is gone when done, and the reply text
// grows then settles. No single signal is trusted and no fixed ordering is
// assumed; several noisy signals combine into a confidence that the response has
// ended. The deterministic timeout makes a FINAL judgement (return if reasonably
// confident, hand off only if not) rather than a dumb fail.
//
// Usage: node ask.mjs "your question"
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CTRL = { host: "127.0.0.1", port: Number(process.env.BROWSERLOG_CTRL_PORT || 9223) };
const DATA = process.env.BROWSERLOG_DIR || path.join(os.homedir(), "browserlog", "data");
const POLL_MS    = Number(process.env.ASK_POLL_MS         || 1000);
const SHORT_MS   = Number(process.env.ASK_STABLE_SHORT_MS || 2500);   // stop-absent + this => HIGH
const MED_MS     = Number(process.env.ASK_STABLE_MED_MS   || 5000);   // stability alone => MEDIUM
const LONG_MS    = Number(process.env.ASK_STABLE_LONG_MS  || 10000);  // stability alone => HIGH
const TIMEOUT_MS = Number(process.env.ASK_TIMEOUT_MS      || 120000); // deterministic backstop

function ctrl(obj, timeoutMs = 30000) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(obj);
    const req = http.request({ ...CTRL, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch { res({ raw: d }); } }); });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("ctrl call timed out")));
    req.on("error", rej); req.write(body); req.end();
  });
}
const val = (r) => r?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function keyActions(text) {
  const a = [];
  for (const ch of text) a.push({ type: "keyDown", value: ch }, { type: "keyUp", value: ch });
  a.push({ type: "keyDown", value: "" }, { type: "keyUp", value: "" }); // Enter
  return [{ type: "key", id: "kb", actions: a }];
}
function handoff(reason) { process.stdout.write("HANDOFF: " + reason + "\n"); process.exit(3); }

// One cheap poll of the two visible signals: is a Stop control present, and the
// length of the current reply text. Selected semantically (aria-label ~ "stop"
// and the reply block), matched loosely — not by a hashed class/id/testid alone.
const STATE_FN = '() => { const stop=[...document.querySelectorAll("button")].some(b=>(b.getAttribute("aria-label")||"").toLowerCase().includes("stop")); const b=[...document.querySelectorAll("[class*=MarkdownRoot]")]; const l=b[b.length-1]; return JSON.stringify({stop, len: l?(l.innerText||"").length:0}); }';
const EXTRACT_FN = '() => { const b=[...document.querySelectorAll("[class*=MarkdownRoot]")]; const l=b[b.length-1]; return l ? (l.innerText||"") : ""; }';

// Confidence that the response has ENDED, from noisy signals. No single signal is
// required and no ordering is assumed — multiple independent paths reach HIGH.
function confidence(stopPresent, len, stableForMs) {
  if (!len) return "NONE";                                              // nothing to return yet
  const stopGone = stopPresent === false;
  if ((stopGone && stableForMs >= SHORT_MS) || stableForMs >= LONG_MS) return "HIGH";
  if ((stopGone && stableForMs >= 1000)     || stableForMs >= MED_MS)  return "MEDIUM";
  return "LOW";                                                         // non-empty but still changing
}

async function finishOrHandoff() {
  // Retry the final extraction a few times: under load a single eval can time out
  // or race the paint, and we don't want to lose a completed reply to that.
  for (let i = 0; i < 4; i++) {
    try {
      const out = val(await ctrl({ cmd: "eval", fn: EXTRACT_FN }));
      if (out && out.trim()) { process.stdout.write(out.trim() + "\n"); process.exit(0); }
    } catch { /* transient; retry */ }
    await sleep(700);
  }
  handoff("looked complete but reply extraction was empty (markup may have shifted)");
}

async function main() {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) { console.error('usage: node ask.mjs "your question"'); process.exit(2); }

  try {
    await ctrl({ cmd: "eval", fn: '() => { const c=document.querySelector("div[contenteditable=true]"); c && c.focus(); return !!c; }' });
    await ctrl({ cmd: "perform", actions: keyActions(question) });
  } catch (e) {
    handoff("could not send the question (control endpoint slow/unreachable): " + e.message);
  }

  const started = Date.now();
  let stopPresent = null, lastLen = -1, lenChangedAt = Date.now();
  for (;;) {
    await sleep(POLL_MS);
    // Poll the visible signals. On a transient failure keep last-known state so a
    // slow/dropped eval does not reset the stability clock.
    try {
      const s = JSON.parse(val(await ctrl({ cmd: "eval", fn: STATE_FN })) || "{}");
      stopPresent = !!s.stop;
      const len = s.len || 0;
      if (len !== lastLen) { lastLen = len; lenChangedAt = Date.now(); }
    } catch { /* keep last-known state */ }

    const len = lastLen < 0 ? 0 : lastLen;
    const stableFor = len > 0 ? Date.now() - lenChangedAt : 0;
    const conf = confidence(stopPresent, len, stableFor);
    const timedOut = Date.now() - started > TIMEOUT_MS;

    if (conf === "HIGH") return finishOrHandoff();
    if (timedOut) {
      // Final judgement at the backstop: accept a reasonably-confident reply
      // instead of dumb-failing; only hand off when confidence is genuinely low.
      if (conf === "MEDIUM") return finishOrHandoff();
      handoff(len ? "reply still changing at timeout (possibly stuck or very slow)"
                  : "no reply within " + Math.round(TIMEOUT_MS / 1000) + "s (possible challenge/login)");
    }
  }
}
main().catch((e) => handoff("error: " + e.message));
