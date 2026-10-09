#!/usr/bin/env bash
# usage: dev.sh <dir: worker|probe-h13> <port> <persistDir> [extra wrangler args...]  -> background, pid in work/dev-<port>.pid
. "$(dirname "$0")/env.sh"
dir=$1; port=$2; persist=$3; shift 3
cd "$(dirname "$0")/../$dir" || exit 1
mkdir -p ../tools/work
nohup npx wrangler dev --local --port "$port" --persist-to "../tools/work/$persist" "$@" > "../tools/work/dev-$port.log" 2>&1 &
echo $! > "../tools/work/dev-$port.pid"
for i in $(seq 1 60); do grep -q "Ready on" "../tools/work/dev-$port.log" && { echo ready; exit 0; }; sleep 1; done
echo "not ready"; tail -20 "../tools/work/dev-$port.log"; exit 1
