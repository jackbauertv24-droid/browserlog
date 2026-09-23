// In-page tap installed via BiDi addPreloadScript. Runs before page scripts
// in each page realm. Its sole purpose is to forward the response bodies that
// BiDi network events do not expose — chiefly streamed chat replies — plus
// XHR and WebSocket payloads, back to the logger over the "browserlog"
// channel. Every hook is wrapped so a failure never disturbs the page.
(channel) => {
  try {
    const KEY = Symbol.for("browserlog.tap");
    if (window[KEY]) return; Object.defineProperty(window, KEY, { value: 1 });
  } catch { return; }
  const post = (o) => { try { channel(JSON.stringify({ href: location.href, top: window === top, ...o })); } catch {} };
  let n = 0; const nid = () => (Date.now().toString(36) + "." + (n++).toString(36));
  const CAP = 20 * 1024 * 1024; // stop copying a single body past this; keep counting

  // ---- fetch: stream the response body, preserving chunk timing ----------
  const oFetch = window.fetch;
  if (typeof oFetch === "function") window.fetch = function (...a) {
    const id = nid();
    try {
      const req = a[0], init = a[1] || {};
      const url = typeof req === "string" ? req : (req && req.url) || String(req);
      const method = (init.method) || (req && req.method) || "GET";
      let body = init.body; if (typeof body === "string") post({ k: "fetch-req", id, url, method, body });
      else post({ k: "fetch-req", id, url, method });
    } catch {}
    const pr = oFetch.apply(this, a);
    pr.then((resp) => {
      try {
        post({ k: "fetch-res", id, url: resp.url, status: resp.status, mime: resp.headers.get("content-type") });
        if (!resp.body) return;
        const clone = resp.clone(); const rd = clone.body.getReader();
        const dec = new TextDecoder("utf-8", { fatal: true }); let ok = true, tot = 0, i = 0;
        const pump = () => rd.read().then(({ done, value }) => {
          if (done) { post({ k: "fetch-body-end", id, bytes: tot, chunks: i }); return; }
          tot += value.byteLength; if (tot > CAP) return pump();
          let c; if (ok) { try { c = dec.decode(value, { stream: true }); } catch { ok = false; } }
          post(ok ? { k: "fetch-chunk", id, i: i++, text: c } : { k: "fetch-chunk", id, i: i++, bin: value.byteLength });
          return pump();
        }).catch((e) => post({ k: "fetch-body-end", id, err: String(e) }));
        pump();
      } catch {}
    }).catch((e) => post({ k: "fetch-err", id, err: String(e) }));
    return pr;
  };

  // ---- XMLHttpRequest ----------------------------------------------------
  try {
    const OX = window.XMLHttpRequest, op = OX.prototype, oOpen = op.open, oSend = op.send;
    op.open = function (m, u) { this.__bl = { id: nid(), m, u: String(u) }; return oOpen.apply(this, arguments); };
    op.send = function (b) {
      const t = this.__bl; if (t) { post({ k: "xhr-req", id: t.id, url: t.u, method: t.m, body: typeof b === "string" ? b : undefined });
        this.addEventListener("load", () => { try { const txt = this.responseType === "" || this.responseType === "text" ? this.responseText : null;
          post({ k: "xhr-res", id: t.id, url: t.u, status: this.status, body: txt && txt.length <= CAP ? txt : undefined, bytes: txt ? txt.length : undefined }); } catch {} });
      }
      return oSend.apply(this, arguments);
    };
  } catch {}

  // ---- WebSocket (e.g. Copilot streaming) --------------------------------
  try {
    const OW = window.WebSocket;
    window.WebSocket = new Proxy(OW, { construct(T, args) {
      const id = nid(); const sock = new T(...args); post({ k: "ws-open", id, url: String(args[0]) });
      const oSendW = sock.send;
      sock.send = function (d) { try { post({ k: "ws-send", id, text: typeof d === "string" ? d : undefined, bytes: typeof d === "string" ? d.length : (d && d.byteLength) }); } catch {} return oSendW.apply(this, arguments); };
      sock.addEventListener("message", (e) => { try { post({ k: "ws-recv", id, text: typeof e.data === "string" ? e.data : undefined, bytes: typeof e.data === "string" ? e.data.length : undefined }); } catch {} });
      sock.addEventListener("close", () => post({ k: "ws-close", id }));
      return sock;
    } });
  } catch {}

  post({ k: "tap-ready" });
}
