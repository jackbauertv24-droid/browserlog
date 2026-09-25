# Deployment & networking/routing reproduction

How the host is wired, so the setup can be rebuilt. Host-specific secrets (public
IP, tunnel domain, the residential exit-node IP, accounts) are **not** here — they
live in a local, gitignored `NOTES.local.md`. The non-secret infra values below
are this host's; adjust for another machine.

## Network baseline (this host)

- NIC: **`ens5`**, address `172.26.4.176/20`, gateway **`172.26.0.1`**, MTU 9001
  (an AWS VPC private range; the public IP is NATed to this by the cloud).
- Tailscale: the host has a tailnet IP and normally **advertises as an exit node**
  (`tailscale set --advertise-exit-node=true`).
- Default state (project suspended): egress is the normal datacenter path; no
  custom policy routing; the desktop stack is stopped and disabled.

## Services

- **Always-on (text baseline):** `cloudflared` (tunnel), `tailscaled`, `ttyd`
  (web terminal on `127.0.0.1:7681`).
- **Desktop stack (disabled at boot; start on demand):** `xvfb` → `openbox` →
  `firefox` (+ `x11vnc`, `novnc`/websockify on `127.0.0.1:5800`). `browserlog` is
  `WantedBy=firefox.service`, so it starts/stops with Firefox.
- **BiDi:** `systemd/bidi.conf` is a drop-in on `firefox.service` adding
  `--remote-debugging-port 9222`. `~/bidi.sh on|off|status` toggles it.
- Unit files for the project live in `systemd/` here; the base desktop units
  (`xvfb`/`openbox`/`firefox`/`x11vnc`/`novnc`) pre-existed on the host.

## Residential egress via Tailscale exit node (the routing setup)

Goal: make **only the browser** egress through a residential Tailscale exit node
(to reduce bot-detection), while **inbound SSH and the cloudflared tunnel stay on
the datacenter path** so they don't break.

Why it's needed: a full-tunnel exit node routes *all* egress through the tunnel,
which (a) breaks inbound SSH — replies to connections that arrived on `ens5` get
sent out the tunnel (asymmetric routing) and dropped — and (b) drags cloudflared
over the tunnel's small MTU, breaking the data-heavy noVNC WebSocket.

Fix = connmark policy routing (`systemd/exitfix-rules.sh`, run by
`systemd/exitfix.service` after `tailscaled`):

- Routing table **100** = `default via 172.26.0.1 dev ens5` (the datacenter path).
- `ip rule` at priority **5200** (below Tailscale's own rules at 5210+, above its
  catch-all `lookup 52` at 5270): traffic with firewall mark **`0x1`** uses table 100.
- iptables `mangle`:
  - `PREROUTING -i ens5 --ctstate NEW -j CONNMARK --set-xmark 0x1/0x1` — mark
    connections that arrive on the NIC (so their replies stay on `ens5` → SSH survives).
  - `OUTPUT -m cgroup --path system.slice/cloudflared.service ... --set-xmark 0x1/0x1`
    — mark cloudflared's own traffic to bypass the exit node (must precede the restore).
  - `OUTPUT -j CONNMARK --restore-mark --nfmask 0x1 --ctmask 0x1` — copy the
    connection mark onto packets so the ip rule routes them.
- Everything the box *initiates unmarked* (the browser) falls through to Tailscale's
  exit-node route → residential egress.

### Enable (residential egress on)

    sudo tailscale set --advertise-exit-node=false --exit-node=<EXIT_NODE_TAILNET_IP> --exit-node-allow-lan-access
    sudo cp systemd/exitfix-rules.sh /home/ubuntu/exitfix-rules.sh && sudo chmod +x /home/ubuntu/exitfix-rules.sh
    sudo cp systemd/exitfix.service /etc/systemd/system/ && sudo systemctl daemon-reload
    sudo systemctl enable --now exitfix.service

`<EXIT_NODE_TAILNET_IP>` is the residential node's tailnet IP (in `NOTES.local.md`).

### Disable (back to datacenter baseline)

    sudo tailscale set --exit-node= --advertise-exit-node=true
    sudo systemctl disable --now exitfix.service   # ExecStop removes all the rules

### Safety when applying remotely

Enabling a full exit node can sever SSH before the policy routing is in place. Do
it under a dead-man's switch: arm a timed auto-revert first, apply detached, then
reconnect on a *fresh* connection to confirm before cancelling the revert.

## Verify

- Egress: `curl -s https://ipinfo.io/json | grep org` (Amazon = datacenter, the
  residential ISP = exit node active).
- SSH survives: open a new SSH session while the exit node is on.
- Rules present: `ip rule show | grep 0x1`; `sudo iptables -t mangle -S | grep 0x1`.
- Tailscale's own rules (mask `0xff0000`) must remain untouched.
