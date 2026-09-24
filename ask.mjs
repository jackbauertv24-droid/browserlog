// ask.mjs — minimal CLI: send one question to the ChatGPT tab and return the
// reply text when the stream completes. Additive: it only talks to browserlog's
// localhost control endpoint and reads the log; it does not modify the logger.
//
// Flow (matches the agreed design):
//   1. type the question into the composer + Enter (via control endpoint)
//   2. wait for completion using the LOG marker (message_stream_complete)
//   3. extract the reply from the DOM ([class*=MarkdownRoot], last block)
//   4. on any failure (no completion, empty extraction) -> request HANDOFF
//   5. timeout is inactivity-based so slow / "thinking" replies aren't cut off
//
// Usage: node ask.mjs "your question"
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CTRL = { host: "127.0.0.1", port: Number(process.env.BROWSERLOG_CTRL_PORT || 9223) };
const DATA = process.env.BROWSERLOG_DIR || path.join(os.homedir(), "browserlog", "data");
const INACTIVITY_MS = Number(process.env.ASK_INACTIVITY_MS || 20000); // no stream activity => stalled
const HARD_CAP_MS = Number(process.env.ASK_HARD_CAP_MS || 240000);    // absolute safety cap

function ctrl(obj) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(obj);
    const req = http.request({ ...CTRL, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch { res({ raw: d }); } }); });
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
  let lastActivity = Date.now();
  let seenActivity = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const chunk = readSince(startOffset);
    // any chatgpt stream activity resets the inactivity clock
    const activity = (chunk.match(/"k":"fetch-chunk"[^\n]*chatgpt\.com|chatgpt\.com[^\n]*"k":"fetch-chunk"/g) || []).length;
    if (activity > 0) { lastActivity = Date.now(); seenActivity = true; }

    if (chunk.includes("message_stream_complete") || chunk.includes('"end_turn"')) {
      const out = evalResult(await ctrl({ cmd: "eval", fn: EXTRACT_FN }));
      if (out && out.trim()) { process.stdout.write(out.trim() + "\n"); process.exit(0); }
      handoff("stream completed but DOM extraction was empty (markup may have shifted)");
    }
    if (seenActivity && Date.now() - lastActivity > INACTIVITY_MS) handoff("stream went silent without completing (possible challenge or stall)");
    if (Date.now() - started > HARD_CAP_MS) handoff("no completion within hard cap");
  }
}
function handoff(reason) { process.stdout.write("HANDOFF: " + reason + "\n"); process.exit(3); }
main().catch((e) => { handoff("error: " + e.message); });
