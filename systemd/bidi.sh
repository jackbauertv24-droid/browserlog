#!/bin/bash
# Toggle Firefox WebDriver BiDi (remote debugging). OFF hides navigator.webdriver
# for clean signups; ON re-enables it and resumes browserlog capture.
set -e
D=/etc/systemd/system/firefox.service.d/bidi.conf
base="/usr/bin/dbus-run-session -- /usr/bin/firefox-esr --no-remote --new-instance"
case "$1" in
  off)

    printf "[Service]\nExecStart=\nExecStart=%s\n" "$base" > "$D"
    systemctl daemon-reload; systemctl restart firefox; sleep 2; systemctl stop browserlog 2>/dev/null || true
    echo "BiDi OFF - navigator.webdriver hidden, robot bar gone. browserlog paused." ;;
  on)
    printf "[Service]\nExecStart=\nExecStart=%s --remote-debugging-port 9222\n" "$base" > "$D"
    systemctl daemon-reload; systemctl restart firefox; sleep 4; systemctl start browserlog
    echo "BiDi ON - remote debugging on 9222, browserlog resumed." ;;
  status)
    grep -q 9222 "$D" && echo "BiDi is currently ON" || echo "BiDi is currently OFF" ;;
  *) echo "usage: bidi.sh on|off|status"; exit 1 ;;
esac
