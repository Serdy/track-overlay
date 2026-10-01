#!/usr/bin/env bash
# ./start.sh [start|stop|restart|status|log]
set -euo pipefail

PORT="${PORT:-8712}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${LOG:-/tmp/track-overlay.log}"
URL="http://127.0.0.1:$PORT/"

# Listeners only. A browser holding a connection to the port shows up in a plain
# `lsof -ti :PORT` too, and killing that kills the browser.
listening() { lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true; }

start() {
  local pid
  pid="$(listening)"
  if [ -n "$pid" ]; then
    echo "already running (pid $pid) — $URL"
    return 0
  fi

  cd "$HERE"
  # stdin on /dev/null, or ffmpeg reads the terminal, earns a SIGTTIN as a background
  # process group, and stops mid-render with the progress bar frozen and no error.
  nohup uv run trackoverlay serve --data data --port "$PORT" --no-browser \
    < /dev/null > "$LOG" 2>&1 &
  disown

  local i
  for i in $(seq 1 60); do
    if curl -fsS -o /dev/null --max-time 2 "$URL" 2>/dev/null; then
      echo "running (pid $(listening)) — $URL"
      return 0
    fi
    sleep 0.25
  done

  echo "it did not come up; the last of $LOG:" >&2
  tail -20 "$LOG" >&2
  return 1
}

stop() {
  local pid
  pid="$(listening)"
  if [ -z "$pid" ]; then
    echo "not running"
    return 0
  fi
  kill $pid
  sleep 1
  [ -n "$(listening)" ] && kill -9 $(listening) 2>/dev/null || true
  echo "stopped"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status)
    pid="$(listening)"
    if [ -n "$pid" ]; then
      echo "running (pid $pid, state $(ps -o stat= -p "$pid" | tr -d ' ')) — $URL"
    else
      echo "not running"
    fi
    ;;
  log) tail -f "$LOG" ;;
  *) echo "usage: $0 [start|stop|restart|status|log]" >&2; exit 2 ;;
esac
