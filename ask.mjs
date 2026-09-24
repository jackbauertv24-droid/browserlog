// ask.mjs — minimal CLI: send one question to the ChatGPT tab and return the
// reply text when the stream completes. Additive: it only talks to browserlog's
// localhost control endpoint and reads the log; it does not modify the logger.
//
// Flow (deterministic, minimal-dependency):
//   1. type the question into the composer + Enter (via control endpoint)
//   2. wait for completion using the LOG marker (message_stream_complete/end_turn)
//   3. extract the reply from the DOM ([class*=MarkdownRoot], last block)
//   4. on empty extraction, or if no reply within a single fixed timeout
//      (ASK_TIMEOUT_MS, default 120s) -> request HANDOFF
// No page-state heuristics: success is prompt via the completion marker; failure
// is a predictable, tunable timeout.
//
// Usage: node ask.mjs "your question"
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CTRL = { host: "127.0.0.1", port: Number(process.env.BROWSERLOG_CTRL_PORT || 9223) };
const DATA = process.env.BROWSERLOG_DIR || path.join(os.homedir(), "browserlog", "data");
// Single deterministic timeout: return promptly on the completion marker, else
// hand off after this fixed, tunable window. No page-state heuristics.
const TIMEOUT_MS = Number(process.env.ASK_TIMEOUT_MS || 120000);

function ctrl(obj, timeoutMs = 30000) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(obj);
    const req = http.request({ ...CTRL, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch { res({ raw: d }); } }); });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("ctrl call timed out")));
    req.on("error", rej); req.write(body); req.end();
  });
}
const evalResult = (r) => r?.result?.value; // script.callFunction returns {result:{type,value}}

function logFile() { return path.join(DATA, new Date().toISOString().slice(0, 10) + ".jsonl"); }
// bytes present now, so we only scan traffic produced after our send
function logSize() { try { return fs.statSync(logFile()).size; } catch { return 0; } }
function readSince(offset) { try { return fs.readFileSync(logFile()).subarray(offset).toString("utf8"); } catch { return ""; } }

function keyActions(text) {
  const a = [];
  for (const ch of text) { a.push({ type: "keyDown", value: ch }, { type: "keyUp", value: ch }); }
  a.push({ type: "keyDown", value: "" }, { type: "keyUp", value: "" }); // Enter
  return [{ type: "key", id: "kb", actions: a }];
}

const EXTRACT_FN =
  '() => { const b=[...document.querySelectorAll("[class*=MarkdownRoot]")]; const last=b[b.length-1]; return last ? (last.innerText||"") : ""; }';

async function main() {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) { console.error("usage: node ask.mjs \"your question\""); process.exit(2); }

  const startOffset = logSize();
  await ctrl({ cmd: "eval", fn: '() => { const c=document.querySelector("div[contenteditable=true]"); c && c.focus(); return !!c; }' });
  await ctrl({ cmd: "perform", actions: keyActions(question) });

  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const chunk = readSince(startOffset);
    if (chunk.includes("message_stream_complete") || chunk.includes('"end_turn"')) {
      const out = evalResult(await ctrl({ cmd: "eval", fn: EXTRACT_FN }));
      if (out && out.trim()) { process.stdout.write(out.trim() + "\n"); process.exit(0); }
      handoff("stream completed but DOM extraction was empty (markup may have shifted)");
    }
    if (Date.now() - started > TIMEOUT_MS) handoff("no reply within " + Math.round(TIMEOUT_MS / 1000) + "s");
  }
}
function handoff(reason) { process.stdout.write("HANDOFF: " + reason + "\n"); process.exit(3); }
main().catch((e) => { handoff("error: " + e.message); });
