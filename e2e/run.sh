#!/usr/bin/env bash
# The one command for the end-to-end tests (spec 12):  e2e/run.sh
#
# Checks the prerequisites, starts the test server on this Mac, installs each test build on the simulator and runs its flows,
# then stops the server (also when something fails) and prints which flows passed. Exit code: 0 every flow passed, 1 a flow
# failed, 2 something was missing or could not be set up.
#
# Settings (all optional):
#   E2E_DEVICE         simulator id to use (default: the booted iPhone 18 Pro, else the first booted iPhone)
#   E2E_ONLY           run only flows whose "group/name" contains this text, e.g. E2E_ONLY=waiting
#   E2E_FLOW_TIMEOUT   seconds a single flow may take before it is stopped (default 240)
#   E2E_PORT           port of the test server (default 8787; the e2e-api build is made for 8787)
#   E2E_API_APP, E2E_MOCK_APP   paths to the two built .app folders (default e2e/builds/<profile>/Excerp.app, see fetch-build.sh)
set -u

ROOT="$(cd "${BASH_SOURCE[0]%/*}/.." && pwd)"
E2E="$ROOT/e2e"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
OUT="$E2E/output/$RUN_ID"
PORT="${E2E_PORT:-8787}"
FLOW_TIMEOUT="${E2E_FLOW_TIMEOUT:-240}"
ONLY="${E2E_ONLY:-}"
KEEP_RUNS="${E2E_KEEP_RUNS:-5}"

# ---- disk space: a run writes logs and screenshots, and a full disk breaks the simulator, Postgres and everything else --
MIN_FREE_MB="${E2E_MIN_FREE_MB:-1000}"
free_mb="$(df -Pk "$ROOT" | { read -r _; read -r _ _ _ avail _; echo $((avail / 1024)); })"
if [ "${free_mb:-0}" -lt "$MIN_FREE_MB" ]; then
  echo "Not enough free disk space to run: ${free_mb:-0} MB free, ${MIN_FREE_MB} MB needed (E2E_MIN_FREE_MB changes this). Free some space and run again."
  exit 2
fi

# ---- prerequisites: name everything that is missing, then stop before doing anything else ------------------------
export PATH="$PATH:$HOME/.maestro/bin" # Maestro's own installer puts it here and leaves PATH alone
missing=""
command -v maestro >/dev/null 2>&1 || missing="$missing\n  - Maestro (https://maestro.mobile.dev; expected on PATH or in ~/.maestro/bin)"
java -version >/dev/null 2>&1 || missing="$missing\n  - a Java 17 or newer runtime (Maestro needs it)"
command -v xcrun >/dev/null 2>&1 || missing="$missing\n  - Xcode command line tools (xcrun)"
command -v node >/dev/null 2>&1 || missing="$missing\n  - Node.js (the test server runs on it)"
command -v curl >/dev/null 2>&1 || missing="$missing\n  - curl"
if [ -n "$missing" ]; then
  printf 'Cannot run the end-to-end tests. Missing:%b\n' "$missing"
  exit 2
fi

# ---- the simulator -----------------------------------------------------------------------------------------------
udid_of() { sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/'; }
DEVICE="${E2E_DEVICE:-}"
if [ -z "$DEVICE" ]; then
  DEVICE="$(xcrun simctl list devices booted | grep -E 'iPhone 18 Pro \(' | head -1 | udid_of)"
  [ -z "$DEVICE" ] && DEVICE="$(xcrun simctl list devices booted | grep -E 'iPhone' | head -1 | udid_of)"
fi
if [ -z "$DEVICE" ] || ! xcrun simctl list devices booted | grep -q "$DEVICE"; then
  echo "No booted iPhone simulator to use. Boot one in Simulator, or set E2E_DEVICE to the id of a booted one."
  exit 2
fi
DEVICE_NAME="$(xcrun simctl list devices booted | grep "$DEVICE" | head -1 | sed -E 's/^ *(.*) \([0-9A-Fa-f-]{36}\).*/\1/')"

# ---- what will run, and the builds it needs ------------------------------------------------------------------------
flows_in() { ls "$E2E/flows/$1"/*.yaml 2>/dev/null | sort; }
selected() { # the flow files of a group that match E2E_ONLY
  for f in $(flows_in "$1"); do
    case "$1/$(basename "$f" .yaml)" in *"$ONLY"*) echo "$f" ;; esac
  done
}
APP_API="${E2E_API_APP:-$E2E/builds/e2e-api/Excerp.app}"
APP_MOCK="${E2E_MOCK_APP:-$E2E/builds/e2e-mock/Excerp.app}"
need_build() { # group, app path, profile
  [ -z "$(selected "$1")" ] && return 0
  if [ ! -d "$2" ]; then
    echo "The $3 build is not at $2. Fetch the latest with:  e2e/fetch-build.sh $3"
    exit 2
  fi
}
need_build api "$APP_API" e2e-api
need_build mock "$APP_MOCK" e2e-mock

echo "End-to-end run $RUN_ID"
echo "  simulator : $DEVICE_NAME ($DEVICE)"
echo "  git HEAD  : $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
for p in e2e-api e2e-mock; do
  info="$E2E/builds/$p/BUILD_INFO"
  [ -f "$info" ] && echo "  build $p : $(cat "$info")" || echo "  build $p : (no BUILD_INFO: not fetched with fetch-build.sh)"
done
echo "  output    : $OUT"
mkdir -p "$OUT"
# Only the last KEEP_RUNS runs are kept (this one included): a run's output is tens of megabytes.
ls -1t "$E2E/output" | tail -n +$((KEEP_RUNS + 1)) | while read -r old; do rm -rf "${E2E:?}/output/${old:?}"; done

# ---- the test server, and cleanup however this script ends ---------------------------------------------------------
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null # on TERM the server drops its throwaway schema before it exits
    for _ in $(seq 1 15); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 1; done
    kill -KILL "$SERVER_PID" 2>/dev/null
  fi
  pkill -f maestro-driver-ios 2>/dev/null # Maestro's own driver processes, which it can leave behind; nothing else matches
  pkill -f "maestro.cli.AppKt" 2>/dev/null
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if curl -fs -m 2 "http://127.0.0.1:$PORT/e2e/ready" >/dev/null 2>&1; then
  echo "Something is already answering on port $PORT. Stop it first, so the flows run against a fresh test server."
  exit 2
fi
(cd "$ROOT/server" && E2E_PORT="$PORT" exec node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON e2e/server.ts) >"$OUT/test-server.log" 2>&1 &
SERVER_PID=$!
ready=""
for _ in $(seq 1 30); do
  kill -0 "$SERVER_PID" 2>/dev/null || break
  curl -fs -m 2 "http://127.0.0.1:$PORT/e2e/ready" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
if [ -z "$ready" ]; then
  echo "The test server did not start. Its log ($OUT/test-server.log) ends:"
  tail -8 "$OUT/test-server.log" | sed 's/^/    /'
  exit 2
fi
echo "  test server up on http://127.0.0.1:$PORT"

# ---- the flows ----------------------------------------------------------------------------------------------------------
RESULTS=""
FAILED=0
PASSED=0
run_group() { # group, app path
  local group="$1" app="$2" files
  files="$(selected "$group")"
  if [ -z "$files" ]; then
    echo "  [$group] no flows to run"
    return 0
  fi
  echo "  [$group] installing $(basename "$(dirname "$app")")"
  xcrun simctl terminate "$DEVICE" com.prateekvibhor.excerp >/dev/null 2>&1
  if ! xcrun simctl install "$DEVICE" "$app"; then
    echo "Could not install $app on the simulator."
    exit 2
  fi
  mkdir -p "$OUT/$group"
  local f name start code secs status
  for f in $files; do
    name="$(basename "$f" .yaml)"
    start="$(date +%s)"
    # A flow that hangs (Maestro can, when something goes wrong while it starts the app) is stopped after FLOW_TIMEOUT seconds:
    # perl runs it, and on the alarm asks it to stop, then forces it, and exits 124 (the code `timeout` uses).
    perl -e 'my $t = shift; my $pid = fork(); if (!$pid) { exec @ARGV or exit 127 }
             $SIG{ALRM} = sub { kill "TERM", $pid; select(undef, undef, undef, 2); kill "KILL", $pid; exit 124 };
             alarm $t; waitpid($pid, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$FLOW_TIMEOUT" maestro test --device "$DEVICE" --format JUNIT --output "$OUT/$group/$name.xml" --test-output-dir "$OUT/$group/$name" "$f" >"$OUT/$group/$name.log" 2>&1
    code=$?
    secs=$(($(date +%s) - start))
    if [ "$code" -eq 0 ]; then
      status="PASS"; PASSED=$((PASSED + 1))
    elif [ "$code" -eq 124 ]; then
      status="TIMEOUT"; FAILED=$((FAILED + 1)); pkill -f maestro-driver-ios 2>/dev/null; pkill -f "maestro.cli.AppKt" 2>/dev/null
    else
      status="FAIL"; FAILED=$((FAILED + 1))
    fi
    printf '    %-7s %s/%s  (%ss)\n' "$status" "$group" "$name" "$secs"
    if [ "$status" = "PASS" ]; then
      rm -rf "${OUT:?}/$group/$name" # a passing flow keeps only its short log and its report; the debug folder is large
    else
      # keep the evidence of a failure, but a simulator log can run to tens of megabytes: keep its last 2 MB
      find "$OUT/$group/$name" -name device-simulator.log -size +5M -exec sh -c 'tail -c 2000000 "$1" > "$1.tail" && mv "$1.tail" "$1"' _ {} \; 2>/dev/null
    fi
    RESULTS="$RESULTS$status $group/$name\n"
  done
}
run_group api "$APP_API"
run_group mock "$APP_MOCK"

# ---- the summary ----------------------------------------------------------------------------------------------------------
TOTAL=$((PASSED + FAILED))
echo
echo "Results: $PASSED of $TOTAL flows passed"
if [ "$FAILED" -gt 0 ]; then
  printf '%b' "$RESULTS" | grep -v '^PASS' | while read -r status flow; do
    if [ "$status" = "TIMEOUT" ]; then
      echo "  $status  $flow   stopped after ${FLOW_TIMEOUT}s; its log is in $OUT/$flow.log"
    else
      echo "  $status  $flow   evidence: $OUT/$flow/ (screenshots and a screen dump), log: $OUT/$flow.log"
    fi
  done
  exit 1
fi
[ "$TOTAL" -eq 0 ] && { echo "No flow matched${ONLY:+ \"$ONLY\"}."; exit 2; }
exit 0
