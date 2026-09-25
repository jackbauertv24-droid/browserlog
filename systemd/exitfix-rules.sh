#!/bin/bash
# Policy routing so a Tailscale exit node makes ONLY the browser egress
# residential, while inbound SSH and the cloudflared management tunnel stay on
# the normal datacenter path. Idempotent. Installed at /home/ubuntu/exitfix-rules.sh.
#
# HOST-SPECIFIC VALUES (adjust per machine): NIC=ens5, gateway=172.26.0.1.
# Generic knobs: routing table 100, firewall mark 0x1, ip-rule priority 5200
# (chosen below Tailscale's own rules at 5210+ but above its catch-all at 5270).
ip route replace default via 172.26.0.1 dev ens5 table 100
ip rule show | grep -q "fwmark 0x1/0x1 lookup 100" || ip rule add fwmark 0x1/0x1 priority 5200 lookup 100
# inbound connections on the NIC -> keep replies on ens5 (protects SSH from asym routing)
iptables -t mangle -C PREROUTING -i ens5 -m conntrack --ctstate NEW -j CONNMARK --set-xmark 0x1/0x1 2>/dev/null || iptables -t mangle -A PREROUTING -i ens5 -m conntrack --ctstate NEW -j CONNMARK --set-xmark 0x1/0x1
# cloudflared tunnel -> keep on datacenter path (bypass exit node); must precede restore-mark
iptables -t mangle -C OUTPUT -m cgroup --path system.slice/cloudflared.service -j CONNMARK --set-xmark 0x1/0x1 2>/dev/null || iptables -t mangle -I OUTPUT 1 -m cgroup --path system.slice/cloudflared.service -j CONNMARK --set-xmark 0x1/0x1
# copy connection mark onto packets so the ip rule routes them
iptables -t mangle -C OUTPUT -j CONNMARK --restore-mark --nfmask 0x1 --ctmask 0x1 2>/dev/null || iptables -t mangle -A OUTPUT -j CONNMARK --restore-mark --nfmask 0x1 --ctmask 0x1
