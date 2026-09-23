# browserlog

A small observability service that records everything a **Firefox** browser
does, by attaching to it over the **WebDriver BiDi** protocol. It is meant for
a headless Firefox running on a server (for example behind a VNC/noVNC desktop),
where you want a durable, replayable record of every page load, network
request/response and streamed body — for later analysis, reverse-engineering a
web app's API, or building automation on top of a site.

It **only observes**. It never sends input to the browser, so it can run
alongside a human using the same browser.

## What it captures

Into append-only JSONL, one file per UTC day, under `data/`:

- **Navigations** — page loads and DOM-content-loaded events per tab.
- **Network (native BiDi events)** — every request and response with URL,
  method, status, MIME type, timing, and full headers and cookies.
- **Bodies (in-page tap)** — the response bodies BiDi does not expose, captured
  by a preload script that wraps `fetch`, `XMLHttpRequest` and `WebSocket`.
  Streamed responses (e.g. server-sent chat replies) are recorded chunk by
  chunk, preserving their arrival order.
- **Console** — log entries and their source.

Because it records cookies and request/response bodies verbatim, **the `data/`
directory contains secrets** (session tokens, anything you type into a page).
It is git-ignored. Treat those logs as sensitive and keep them on a machine you
control.

## How it works

`logger.mjs` opens a single BiDi session to a Firefox started with
`--remote-debugging-port`, subscribes to the network/navigation/console events,
installs `tap.js` as a preload script, and writes each event as one JSON line.
`tap.js` runs inside every page and forwards bodies back over a BiDi channel.

Firefox allows only **one** BiDi session at a time, so a logger and any
future automation must share the one session rather than each opening their own.

## Requirements

- Firefox (tested with Firefox ESR 140) launched with `--remote-debugging-port 9222`
- Node.js 22+ (uses the global `WebSocket`-free path via the `ws` package; developed on Node 24)
- `zstd` for the daily log compression

## Run

```sh
npm install
# Firefox must already be running with --remote-debugging-port 9222
node logger.mjs
```

Environment variables:

- `BIDI_URL` — BiDi endpoint (default `ws://127.0.0.1:9222/session`)
- `BROWSERLOG_DIR` — output directory (default `./data`)

## Self-test

`test-e2e.mjs` drives a throwaway navigation to `example.com`, triggers an
in-page `fetch`, and confirms both native network events and tapped bodies are
captured:

```sh
node test-e2e.mjs
```

## Deployment (systemd)

The `systemd/` directory holds unit files for running browserlog as a service
bound to a `firefox.service`, plus a daily timer that compresses finished days
with `zstd` (it never deletes). `systemd/bidi.conf` is a drop-in that adds the
`--remote-debugging-port` flag to an existing Firefox unit. Adjust the paths and
the Node binary location to your host before installing.

## License

ISC
