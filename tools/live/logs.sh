#!/usr/bin/env bash
# usage: logs.sh h13|worker  (live tail, Ctrl+C to stop). Gmail addresses redacted before writing.
source "$(dirname "$0")/cf-env.sh" || exit 1
[ "${CF_ENV_READY:-}" = 1 ] || exit 1
case "${1:-}" in h13) N=capture-h13;; worker) N=capture-worker;; *) echo "usage: logs.sh h13|worker"; exit 1;; esac
D="$POC_DIR/evidence/p4"; mkdir -p "$D"
cd "$POC_DIR/worker" && npx wrangler tail "$N" --format json | sed -u -E 's/[A-Za-z0-9._%+-]+@(gmail|googlemail)\.com/<redacted-email>/g' | tee -a "$D/tail-$N-$(date +%Y%m%d).jsonl"
