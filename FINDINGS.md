# Findings & design notes

Research notes from using **browserlog** to observe a real, human-driven Firefox
and work toward a broker that drives web chat interfaces (ChatGPT first) through
a CLI/API. Environment-specific values (IPs, hostnames, account identifiers) are
deliberately omitted here.

## Goal

Keep a headless Firefox (behind a VNC/noVNC desktop) running with WebDriver BiDi
enabled. A human logs in and handles anything that needs a human. A broker then
exposes a CLI/API that:

- takes a question, **simulates typing it into the site's composer and sends it**
  (UI-driven, so the site's own JavaScript builds the request with valid
  anti-bot tokens — we do not reverse-engineer or replay those);
- **captures the streamed answer from the network** (via the in-page tap, not by
  scraping the DOM) and returns it through the CLI/API;
- handles UI edge cases — delays, slow answers, truncation, interruption;
- on any bot challenge, **flags the operator and hands off to noVNC** rather than
  trying to solve it itself.

The always-on browser is the primary path; hand driving in noVNC is the
least-preferred fallback.

## Bot-detection findings (the big lessons)

These systems gate on two independent signals, and they bite at different times:

1. **IP reputation.** A datacenter/hosting IP is treated as high-risk. From such
   an IP, email-verification and signup are refused *before any email is sent*:
   OpenAI's send-OTP endpoint returned **403** (behind AWS WAF), and DeepSeek's
   `create_email_verification_code` returned HTTP 200 with a body of
   `code: 2, "RECAPTCHA_VERIFY_FAILED"`. So a failed signup here is **not** an
   email-provider problem — the request to send the code was blocked.
2. **The automation flag.** With BiDi/remote-debugging attached, Firefox sets
   `navigator.webdriver = true`, which any page can read. `remote.prefs.recommended
   = false` keeps Firefox's *other* settings normal but does **not** hide this
   flag. There is also a headless fingerprint: no GPU, software WebGL renderer
   (Mesa/llvmpipe) — characteristic of a server/VM.

**Key confirmed distinction:**

- **Signup is the hard gate.** It fails on a datacenter IP, and the automation
  flag/headless fingerprint compound it. A residential egress IP removes the
  biggest factor but not the fingerprint, so signup can still be challenged.
- **Logged-in chat is trusted.** With a valid session cookie, ChatGPT serves the
  full authenticated experience and lets you chat **even with `navigator.webdriver
  = true`** — messages send and replies stream normally. This is what makes the
  broker viable: a human logs in once; the automation drives the logged-in
  session with BiDi on.

Practical recipe: for signup, use a residential IP **and** turn BiDi off; for the
broker driving a logged-in session, BiDi on is fine.

## ChatGPT behaviour (captured from real logged-in sessions)

- **Send:** `POST /backend-api/f/conversation/prepare`, then the conversation
  POST carrying `conversation_id` and `parent_message_id`.
- **New conversation:** `POST /backend-api/conversation/init`.
- **Reply stream:** Server-Sent Events. First `event: delta_encoding`, then many
  incremental `event: delta` updates.
- **Completion signals:** `message_stream_complete`, `finished_successfully`,
  `end_turn`.
- **Cut-off reply (Stop pressed):** `interrupted`.
- **Length-capped reply:** `max_tokens`.
- **Thinking/reasoning mode:** `reasoning` and `thinking` events precede the
  answer — this is the source of the longest pre-answer delays.
- **Per-message anti-bot gate:** `sentinel/chat-requirements/prepare` then
  `finalize` (200 when healthy). Deviation from this (a challenge/proof-of-work
  demand, a 403 on send, a Turnstile iframe going interactive, or a usage-cap
  response) is what the broker should treat as "needs a human."

So a reply can end three distinguishable ways: **completed**
(`message_stream_complete`/`finished_successfully`/`end_turn`), **stopped**
(`interrupted`), or **truncated** (`max_tokens`).

## Adapter/broker plan and its risks

Architecture (all runs on the server, additive to browserlog):

1. **Broker** holds the single BiDi session (Firefox allows only one) and exposes
   a local CLI/API. It must be the evolution of browserlog's observation layer,
   not a second BiDi client.
2. **`send(text)`** locates the composer via BiDi, types, and presses Enter.
3. **Reply reader** consumes the SSE off the in-page tap, assembles `delta`
   events, returns text on the completion marker, surfaces `interrupted`/
   `max_tokens` as status.
4. **Challenge/limit detector** flags the operator and hands off to noVNC on any
   deviation from the known-good pattern.

**Evidence status — honest assessment.** The *reading* side is well-evidenced
(all of the ChatGPT behaviour above was captured from real traffic). The
*controlling* side is largely unvalidated and is where implementation risk lives:

- **DOM send (highest risk).** ChatGPT's composer is a rich `contenteditable`
  editor, not a plain textbox. Whether BiDi input reliably types into it and
  triggers a real send is unproven.
- **Request/response correlation.** Isolating *the SSE stream that answers the
  message we just sent* from all concurrent traffic, in real time, is unproven.
- **Live data path.** browserlog writes to a log file; the broker must consume the
  tap in real time. The tap fires reliably, but real-time request/response on top
  of it is unbuilt.
- **Single-session sharing.** Firefox allows one BiDi session; browserlog holds
  it (the "max sessions" error was observed). The broker must share/replace it.

**De-risking approach (to avoid the build → break → recapture loop):** validate
the unknowns with three isolated proof-of-concept probes *before* building the
adapter, without modifying the working browserlog/routing:

- **Probe A — dual role:** one BiDi client both observes (tap + events) and sends
  input.
- **Probe B — the send:** BiDi types into the composer and triggers a real send
  (success = a new `/f/conversation` POST fires).
- **Probe C — end-to-end read:** isolate that send's SSE stream from the tap,
  follow it to a completion marker, extract the answer text.

Only when A/B/C are green do we build. Freeze what works; the broker is additive;
no adapter code until the probes pass with logged evidence.

## Progress log (milestones)

- **M1 — observation.** browserlog captures all traffic/events/bodies from a
  human-driven session (the original logger).
- **M2 — control role added (Probe A green).** The logger now also exposes a
  localhost-only control endpoint (`127.0.0.1:9223`, POST JSON) that drives the
  *same* single BiDi session on demand: `eval` (run JS in the page), `perform`
  (raw `input.performActions`), `navigate`, `shot`, `tabs`. Observation is
  unchanged and additive; every control command is logged as `t:"ctrl"`. This
  proves one BiDi client can both observe and send — confirmed by an `eval`
  returning the page title through the observing session. Also made restart-safe:
  graceful shutdown closes the WebSocket so Firefox frees its single session
  slot, plus a session-acquire retry — fixing the "max sessions" zombie wedge
  that otherwise appears on every restart. Next: use `eval`/`perform` to
  experiment with sending into ChatGPT's composer and let browserlog record the
  whole resulting behaviour (no capture code yet).

- **M3 — send loop proven (Probes B + C green).** Read-only DOM inspection first:
  ChatGPT's composer is a single `<div contenteditable="true" role="textbox">`
  with class `ProseMirror` and placeholder "Ask ChatGPT", inside a `<form>`; the
  send button only renders once there is text. Then a real send via the control
  endpoint: focus the composer, type the message with **real keystrokes**
  (`input.performActions` — ProseMirror ignores naive `textContent` writes), and
  press **Enter** (``) to submit. Result: a genuine `/f/conversation`
  send, the SSE reply streamed and was captured by browserlog with clean
  completion markers, and the answer rendered on screen — with **no challenge or
  ban** on a logged-in session with BiDi on. This validates the whole control
  loop end to end (type → send → stream → complete) before any adapter code.
  Still to build: real-time isolation of *this* send's reply stream from
  concurrent traffic, and wrapping the loop as the broker's `send()`/`reply()`.

## Infrastructure lessons (generic)

- **Tailscale exit node + inbound SSH.** Routing a cloud box's whole egress
  through a Tailscale exit node breaks inbound SSH on its public IP: reply packets
  to connections that arrived on the physical NIC get sent out the tunnel
  (asymmetric routing) and dropped. Fix with connmark policy routing — mark new
  inbound connections on the NIC, restore the mark on `OUTPUT`, and route marked
  packets via a table whose default is the real NIC gateway. Traffic the box
  *initiates* (a browser) still egresses via the exit node.
- **Exclude the management tunnel from the exit node.** A tunnel daemon
  (e.g. cloudflared) dragged through the exit node's small-MTU link breaks
  data-heavy WebSockets (the small HTTP page still loads, but the stream fails).
  Pin the tunnel daemon's traffic to the datacenter path (match its cgroup, mark
  it like inbound). Only the browser needs to be residential.
- **Risky remote changes need a dead-man's switch.** For a change that could sever
  the only way back in, arm a timed auto-revert first (a server-side timer that
  survives SSH dropping), apply the change **detached** so it completes even if
  SSH dies, then reconnect on a *fresh* connection to test, and only cancel the
  timer once confirmed. A fresh connection matters — an established one can pass
  on conntrack state and hide a break.
- **Memory.** On a ~1 GB box, each heavy chat/mail SPA costs ~40–220 MB plus a
  ~185 MB fixed Firefox baseline; several open at once forces swap and constant
  memory-pressure stalls. Keeping four such tabs resident is not realistic there.
