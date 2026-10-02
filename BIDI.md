# Firefox WebDriver BiDi — how-to, debugging and lessons

A practical guide to driving and observing a real Firefox over WebDriver BiDi, as
done in this project: turning it on, talking to it, what goes wrong and how to
tell, and what was learned the hard way. It complements `README.md` (what
browserlog is) and `FINDINGS.md` (research log). Host-specific values are not in
this repo.

## 1. What BiDi is here

WebDriver BiDi is a two-way JSON protocol over a WebSocket. Firefox speaks it
natively when started with `--remote-debugging-port`. Unlike classic WebDriver
(request/response only), the browser **pushes events** — network requests,
navigations, console messages — while you can also **send commands** (run JS,
type, navigate, screenshot).

The setup in this project:

    Xvfb :99 → openbox → firefox-esr --remote-debugging-port 9222
                              │  ws://127.0.0.1:9222/session  (BiDi)
                              ▼
                       logger.mjs  ── writes data/YYYY-MM-DD.jsonl
                              │
                       127.0.0.1:9223  control endpoint (POST JSON)
                              ▲
                          ask.mjs  (types a question, waits, reads the reply)

A human uses the same Firefox through noVNC at the same time.

## 2. Turning BiDi on and off

BiDi is controlled by one flag on Firefox's command line, set through a systemd
drop-in so the base unit stays untouched:

    # /etc/systemd/system/firefox.service.d/bidi.conf  (ON)
    [Service]
    ExecStart=
    ExecStart=/usr/bin/dbus-run-session -- /usr/bin/firefox-esr --no-remote --new-instance --remote-debugging-port 9222

The empty `ExecStart=` is required — it clears the base unit's command before
setting a new one. OFF is the same file without `--remote-debugging-port 9222`.

A toggle script (`systemd/bidi.sh on|off|status`, installed on the host as `~/bidi.sh`) writes that drop-in, reloads systemd,
restarts Firefox and starts/stops browserlog with it:

    sudo ./bidi.sh status
    sudo ./bidi.sh off     # clean browser: no navigator.webdriver, no robot icon
    sudo ./bidi.sh on      # BiDi back on, browserlog resumes

**Restarting Firefox closes every tab.** Logins survive (cookies are in the
profile), open pages do not.

When to use which:
- **OFF** for anything a site might gate on automation: signups, email/OTP
  verification, first logins on a new account.
- **ON** for driving an already logged-in session — logged-in chat worked fine with
  BiDi on (see §8).

## 3. Checking it's on

    ss -ltnp | grep 9222                  # Firefox listening, must be 127.0.0.1 only
    systemctl cat firefox | grep 9222     # flag present in the effective unit
    systemctl is-active browserlog        # the observer attached

Visible signs in the browser itself: a **robot icon** in the address bar and
striped address bar = remote control active. In any page,
`navigator.webdriver` is `true`.

**Never expose 9222 or 9223.** They are full remote control of the browser and
every logged-in account in it. Both bind to `127.0.0.1`; reach them only through
SSH on the host.

## 4. Talking BiDi by hand

Messages are JSON objects with an `id`, a `method` and `params`; replies come
back with the same `id` and `type: "success"` or `"error"`. Events arrive with
`type: "event"` and no `id`.

Minimal sequence (Node 22+, `ws` package — see `test-e2e.mjs` for a runnable one):

    session.new             {capabilities: {}}            → sessionId
    session.subscribe       {events: ["network.beforeRequestSent", ...]}
    browsingContext.getTree {}                            → contexts[0].context  (= a tab)
    browsingContext.navigate {context, url, wait: "complete"}
    script.callFunction     {functionDeclaration: "() => document.title",
                             target: {context}, awaitPromise: true}
    input.performActions    {context, actions: [...]}     (keystrokes, mouse)
    browsingContext.captureScreenshot {context}           → base64 PNG

Events browserlog subscribes to: `browsingContext.contextCreated`, `.load`,
`.domContentLoaded`, `network.beforeRequestSent`, `network.responseCompleted`,
`network.fetchError`, `log.entryAdded`, `script.message`.

Quick self-test (from the repo, with BiDi on and browserlog **stopped** — see §6):

    sudo systemctl stop browserlog
    node test-e2e.mjs        # expect: native res events > 0, tap kinds incl. fetch-chunk, "ok"
    sudo systemctl start browserlog

## 5. Getting response bodies: the in-page tap

BiDi network events give URLs, headers, cookies, status and timing, but **not
response bodies** — and streamed chat replies are exactly what's needed. So
`tap.js` is installed with `script.addPreloadScript`; it runs before page
scripts in every page and wraps `fetch`, `XMLHttpRequest` and `WebSocket`,
posting each request, response and **stream chunk** back over a BiDi channel
(`script.message` events, channel `browserlog`).

Notes:
- The preload only applies to pages loaded **after** it's installed. Reload a tab
  after (re)starting the logger to tap it.
- Every hook is wrapped in try/catch so a tap failure never breaks the page.
- Bodies over 20 MB stop being copied (still counted).
- A guard (`Symbol.for("browserlog.tap")`) prevents double-wrapping.

## 6. The single-session rule (the most common failure)

**Firefox allows exactly one BiDi session.** A second `session.new` fails with a
"maximum number of active sessions" error. Consequences:

- browserlog holds the session; any other tool (a test, a script, a second
  logger) must either go through browserlog's control endpoint or stop it first.
- **Zombie session on restart:** if the logger is killed without closing its
  WebSocket, Firefox keeps the session slot for a while and the restarted logger
  can't get one. Fixes now in `logger.mjs`: close the WebSocket on SIGTERM/SIGINT,
  and retry `session.new` up to 8 times, 3 s apart.
- If it's still wedged: `sudo systemctl restart firefox` (the logger follows, it's
  bound to `firefox.service`).

## 7. The control endpoint (drive the same session)

`logger.mjs` listens on `127.0.0.1:9223` and executes commands through **its own**
session, so observing and driving never conflict. Every command is logged as a
`t:"ctrl"` record (failures as `t:"ctrl-err"`).

    C=http://127.0.0.1:9223
    curl -s $C -d '{"cmd":"tabs"}'
    curl -s $C -d '{"cmd":"eval","expr":"document.title"}'
    curl -s $C -d '{"cmd":"navigate","url":"https://example.com/"}'
    curl -s $C -d '{"cmd":"shot"}' | python3 -c 'import sys,json,base64;open("shot.png","wb").write(base64.b64decode(json.load(sys.stdin)["data"]))'

Commands: `tabs`, `eval` (`expr` or full `fn`, optional `context`), `perform`
(raw `input.performActions`), `navigate`, `shot`. Without `context` they act on
the first tab.

### Typing into rich editors

ChatGPT's composer is a ProseMirror `<div contenteditable="true">`. Setting
`textContent`/`value` does **nothing useful** — the editor ignores it and the send
button never appears. What works:

1. `eval` to focus it: `document.querySelector("div[contenteditable=true]").focus()`
2. `perform` real keystrokes — a `keyDown`/`keyUp` pair per character
3. Enter to submit: key value `""` (the WebDriver code for Enter)

`ask.mjs` → `keyActions()` builds that action list.

## 8. Observing a chat reply (ChatGPT, as captured)

- Send: `POST /backend-api/f/conversation/prepare`, then the conversation POST.
- Reply: Server-Sent Events — `event: delta_encoding`, then many `event: delta`
  JSON-patch operations on `/message/content/parts/0`. A raw grep of the log will
  **not** reconstruct the text; it has to be patched together, or read from the DOM.
- Ends: completed (`message_stream_complete` / `finished_successfully` /
  `end_turn`), stopped (`interrupted`), truncated (`max_tokens`).
- Per-message anti-bot gate: `sentinel/chat-requirements/prepare` then `finalize`.

**The marker names rotate.** Over a few days the completion signal moved between
`end_turn`, `message_stream_complete` and `finished_successfully`. Code that
waits for one exact marker breaks silently. This is why `ask.mjs` stopped relying
on a single marker (§10).

## 9. Reading the logs

One JSONL file per UTC day in `data/`; finished days are compressed to `.zst`
(never deleted). **The logs contain cookies and everything typed — treat as
secrets.**

Record types (`t`): `nav`, `tab`, `req`, `res`, `neterr`, `log`, `tap`, `ctrl`,
`ctrl-err`, `meta`. Tap kinds (`k`): `fetch-req`, `fetch-res`, `fetch-chunk`,
`fetch-body-end`, `fetch-err`, `xhr-req`, `xhr-res`, `ws-open`, `ws-send`,
`ws-recv`, `ws-close`, `tap-ready`. A typical day held ~650 tap records against
~280 native request/response pairs.

    # what's in a day
    zstdcat data/2026-09-24.jsonl.zst | python3 -c 'import sys,json,collections;print(collections.Counter(json.loads(l).get("t") for l in sys.stdin))'
    # today's requests to one host
    grep '"t":"req"' data/$(date -u +%F).jsonl | grep chatgpt.com | tail
    # every chunk of one tapped fetch, in order
    grep '"id":"<fetch-id>"' data/$(date -u +%F).jsonl | grep fetch-chunk
    # control commands and their failures
    grep -E '"t":"ctrl(-err)?"' data/$(date -u +%F).jsonl | tail

## 10. Lessons learned

- **Detect completion from what the user sees, combined with confidence — not from
  one invisible marker.** Hidden identifiers (SSE marker names, hashed CSS
  classes) rotate; visible behaviour is stable: a Stop control shows while
  generating and disappears at the end, and the reply text grows then settles.
  `ask.mjs` combines Stop-present/absent and text-stable-for-N-seconds into a
  confidence level (HIGH/MEDIUM/LOW), with one fixed timeout (`ASK_TIMEOUT_MS`,
  default 120 s) as a final judgement: return if reasonably confident, hand off if
  not. **This version is unverified** — it could not be tested on the starved box.
- **Inactivity is not "stalled".** A long reply paused >20 s mid-generation and then
  finished; a pure log-silence timeout reported a false handoff.
- **Every control call needs its own timeout** (30 s in `ask.mjs`). Under memory
  pressure a trivial `eval` hung indefinitely and froze the whole CLI.
- **Don't claim a fix you haven't reproduced.** A "render race" fix was committed
  without ever seeing the race; it was reverted (`bfc003c`). Fix only what you can
  show failing.
- **Fail loud.** When extraction is empty or confidence is low, print
  `HANDOFF: <reason>` and exit non-zero rather than return possibly-wrong text.
- **Memory decides everything on a ~1 GB box.** ChatGPT's app needs ~0.9–1.2 GB of
  Firefox memory; with ~909 MB RAM the box swaps, evals time out and replies don't
  render in time. That is why the project is suspended — not the logic.
- **Bot detection has two independent signals:** IP reputation (datacenter IPs get
  signup/OTP refused before any email is sent) and the automation flag
  (`navigator.webdriver = true` with BiDi on, plus a software-WebGL headless
  fingerprint). `remote.prefs.recommended = false` does not hide the flag.
  Signup = residential IP + BiDi off. Logged-in chat = fine with BiDi on.
- **Replaying requests with curl doesn't work** for ChatGPT: per-message
  proof-of-work tokens and TLS fingerprinting require the real browser. Drive the
  UI and let the site's own JavaScript build requests.

## 11. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| `session.new` fails: max sessions | another client holds the one session (logger, a test, a zombie) | stop the other client; or `systemctl restart firefox` |
| Logger keeps restarting after a deploy | zombie session from an unclean kill | it retries 8×3 s; if still stuck, restart Firefox |
| Connection refused on 9222 | BiDi flag off, or Firefox not up yet | `bidi.sh status`; `systemctl status firefox` |
| No `tap` records for a tab | tab loaded before the tap was installed | reload the tab |
| `eval` / `ctrl call timed out` | box swapping; page busy | check `free -m` and memory PSI; close tabs; raise timeouts |
| Typed text doesn't appear in an editor | rich editor ignores DOM writes | focus + real keystrokes via `perform` |
| Reply finished but CLI hands off | completion marker renamed, or a long pause | check the log for the current marker; see §10 |
| Site shows a challenge / blocks signup | datacenter IP and/or `navigator.webdriver` | BiDi off, residential egress, human in noVNC |
| Robot icon in the address bar | BiDi is on | expected; `bidi.sh off` to remove |

## 12. Safe-operation checklist

- 9222 and 9223 on `127.0.0.1` only; noVNC behind the tunnel + Access.
- `data/` is git-ignored and holds secrets; never commit or share it.
- Turn BiDi off for signups and first logins.
- Before restarting Firefox, remember open tabs will close.
- On a ~1 GB box, keep one heavy app tab open, not several.
