#!/bin/bash
# Compress every .jsonl in data/ except today, with zstd. Never deletes.
set -euo pipefail
cd "$(dirname "$0")/data"
today="$(date -u +%F)"
for f in *.jsonl; do
  [ -e "$f" ] || continue
  [ "$f" = "$today.jsonl" ] && continue
  zstd -q --rm -19 "$f" 2>/dev/null || zstd -q --rm "$f"
done
