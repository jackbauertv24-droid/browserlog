// browserlog — observes the noVNC Firefox over WebDriver BiDi and writes an
// append-only JSONL record of every navigation, network request/response
// (headers, cookies, status, timing) and console entry, plus response and
// streamed bodies captured by an in-page tap. One JSONL file per UTC day.
//
// Runs as a systemd service bound to firefox.service. It only observes; it
// never sends input to the browser.
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ENDPOINT = process.env.BIDI_URL || "ws://127.0.0.1:9222/session";
const DATA = process.env.BROWSERLOG_DIR || path.join(os.homedir(), "browserlog", "data");
const TAP = fs.readFileSync(path.join(import.meta.dirname, "tap.js"), "utf8");

fs.mkdirSync(DATA, { recursive: true });

// ---- daily JSONL sink ---------------------------------------------------
let day = "", stream = null;
function utcDay(ts = Date.now()) { return new Date(ts).toISOString().slice(0, 10); }
function sink() {
  const d = utcDay();
  if (d !== day) { stream?.end(); day = d; stream = fs.createWriteStream(path.join(DATA, d + ".jsonl"), { flags: "a" }); }
  return stream;
}
function write(rec) { try { sink().write(JSON.stringify(rec) + "\n"); } catch (e) { process.stderr.write("write err " + e.message + "\n"); } }

// ---- BiDi client --------------------------------------------------------
let ws, id = 0, session = null;
const pend = new Map();
function send(method, params = {}) {
  return new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
}
function flat(headers) { const o = {}; for (const h of headers || []) o[h.name] = h.value?.value ?? h.value; return o; }

function onEvent(m) {
  const p = m.params || {};
  switch (m.method) {
    case "browsingContext.load":
    case "browsingContext.domContentLoaded":
      write({ t: "nav", ev: m.method.split(".")[1], ctx: p.context, url: p.url, ts: p.timestamp }); break;
    case "browsingContext.contextCreated":
      write({ t: "tab", ev: "created", ctx: p.context, url: p.url, ts: Date.now() }); break;
    case "network.beforeRequestSent":
      write({ t: "req", ctx: p.context, rid: p.request?.request, url: p.request?.url, method: p.request?.method,
        headers: flat(p.request?.headers), cookies: p.request?.cookies, ts: p.timestamp }); break;
    case "network.responseCompleted":
      write({ t: "res", ctx: p.context, rid: p.request?.request, url: p.response?.url, status: p.response?.status,
        mime: p.response?.mimeType, headers: flat(p.response?.headers), bytes: p.response?.bodySize,
        fromCache: p.response?.fromCache, ts: p.timestamp }); break;
    case "network.fetchError":
      write({ t: "neterr", ctx: p.context, rid: p.request?.request, url: p.request?.url, error: p.errorText, ts: p.timestamp }); break;
    case "log.entryAdded":
      write({ t: "log", level: p.level, text: p.text, method: p.method, url: p.source?.realm, ts: p.timestamp }); break;
    case "script.message":
      // messages from the in-page tap arrive as the channel payload (a JSON string)
      try { write({ t: "tap", ...JSON.parse(p.data?.value ?? p.data) }); } catch { write({ t: "tap-raw", data: p.data }); }
      break;
  }
}

async function main() {
  ws = new WebSocket(ENDPOINT);
  ws.on("message", (d) => { const m = JSON.parse(d);
    if (m.id && pend.has(m.id)) { const q = pend.get(m.id); pend.delete(m.id); m.type === "success" ? q.res(m.result) : q.rej(new Error((m.error || "err") + ": " + (m.message || ""))); }
    else if (m.type === "event") onEvent(m);
  });
  ws.on("close", () => { write({ t: "meta", ev: "bidi-closed", ts: Date.now() }); process.exit(0); });
  ws.on("error", (e) => { process.stderr.write("ws error " + e.message + "\n"); process.exit(1); });
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });

  const s = await send("session.new", { capabilities: {} });
  session = s.sessionId;
  await send("session.subscribe", { events: [
    "browsingContext.contextCreated", "browsingContext.load", "browsingContext.domContentLoaded",
    "network.beforeRequestSent", "network.responseCompleted", "network.fetchError",
    "log.entryAdded", "script.message" ] });
  // channel the tap posts to; installed for all future navigations and existing tabs
  await send("script.addPreloadScript", { functionDeclaration: TAP,
    arguments: [{ type: "channel", value: { channel: "browserlog" } }] });
  write({ t: "meta", ev: "started", session, ff: s.capabilities?.browserVersion, ts: Date.now() });
  process.stderr.write("browserlog started, session " + session?.slice(0,8) + "\n");
}
main().catch((e) => { process.stderr.write("fatal " + e.message + "\n"); process.exit(1); });
