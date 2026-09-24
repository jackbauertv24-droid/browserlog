// browserlog — observes the noVNC Firefox over WebDriver BiDi and writes an
// append-only JSONL record of every navigation, network request/response
// (headers, cookies, status, timing) and console entry, plus response and
// streamed bodies captured by an in-page tap. One JSONL file per UTC day.
//
// Runs as a systemd service bound to firefox.service. Observation is passive.
// It also exposes a localhost-only control endpoint that can drive the SAME
// BiDi session on demand (eval, input, screenshot) so experiments can be run
// through the one allowed session; every control command is logged too.
import WebSocket from "ws";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ENDPOINT = process.env.BIDI_URL || "ws://127.0.0.1:9222/session";
const DATA = process.env.BROWSERLOG_DIR || path.join(os.homedir(), "browserlog", "data");
const CTRL_PORT = Number(process.env.BROWSERLOG_CTRL_PORT || 9223);
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

// ---- control endpoint (localhost only) ----------------------------------
// Drives the same BiDi session on demand. POST JSON {cmd, ...} to
// http://127.0.0.1:CTRL_PORT. This is additive; it never affects observation.
async function firstContext() {
  const t = await send("browsingContext.getTree", {});
  return t.contexts?.[0]?.context;
}
async function handleControl(m) {
  switch (m.cmd) {
    case "tabs":
      return await send("browsingContext.getTree", {});
    case "eval": {
      const ctx = m.context || await firstContext();
      const fn = m.fn || `() => { return (${m.expr}); }`;
      return await send("script.callFunction", { functionDeclaration: fn, target: { context: ctx }, awaitPromise: m.await !== false });
    }
    case "perform": {
      // raw input.performActions passthrough: { context?, actions:[...] }
      const ctx = m.context || await firstContext();
      return await send("input.performActions", { context: ctx, actions: m.actions });
    }
    case "shot": {
      const ctx = m.context || await firstContext();
      return await send("browsingContext.captureScreenshot", { context: ctx });
    }
    case "navigate": {
      const ctx = m.context || await firstContext();
      return await send("browsingContext.navigate", { context: ctx, url: m.url, wait: m.wait || "complete" });
    }
    default:
      throw new Error("unknown cmd: " + m.cmd);
  }
}
function startControl() {
  http.createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(405); return res.end("POST only\n"); }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on("end", async () => {
      let m; try { m = JSON.parse(body || "{}"); } catch { res.writeHead(400); return res.end('{"error":"bad json"}'); }
      write({ t: "ctrl", cmd: m.cmd, arg: m.expr || m.url || (m.actions ? "actions" : undefined), ts: Date.now() });
      try {
        const out = await handleControl(m);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        write({ t: "ctrl-err", cmd: m.cmd, error: String(e), ts: Date.now() });
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  }).listen(CTRL_PORT, "127.0.0.1", () => process.stderr.write("control on 127.0.0.1:" + CTRL_PORT + "\n"));
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

  // Acquire the single BiDi session, retrying briefly in case a just-killed
  // predecessor's session is still being released by Firefox.
  let s;
  for (let attempt = 1; ; attempt++) {
    try { s = await send("session.new", { capabilities: {} }); break; }
    catch (e) {
      if (attempt >= 8) throw e;
      process.stderr.write("session.new retry " + attempt + ": " + e.message + "\n");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
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
  startControl();
}
// Graceful shutdown: close the WebSocket so Firefox releases the single BiDi
// session immediately, instead of leaving a zombie that blocks the next start.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { try { ws?.close(); } catch {} setTimeout(() => process.exit(0), 400); });
}

main().catch((e) => { process.stderr.write("fatal " + e.message + "\n"); process.exit(1); });
