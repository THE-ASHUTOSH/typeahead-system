#!/usr/bin/env bash
#
# run.sh — one-stop launcher for the Search Typeahead System.
#
# Usage:
#   ./run.sh            # full setup + start API and UI (default)
#   ./run.sh setup      # one-time: install deps, generate dataset, ingest into Postgres
#   ./run.sh up         # start docker infra (Postgres + 3 Redis) only
#   ./run.sh api        # start the backend API (foreground, :8080)
#   ./run.sh ui         # start the frontend dev server (foreground, :5173)
#   ./run.sh dev        # start infra, then API + UI together (Ctrl-C stops both)
#   ./run.sh bench      # run the performance benchmark (API must be running)
#   ./run.sh test       # run the backend unit tests
#   ./run.sh down       # stop the docker infra (keeps data)
#   ./run.sh reset      # stop infra AND wipe the database volume (fresh start)
#
# Requirements: Docker (with compose), Node 18+ (22 recommended), npm.

set -euo pipefail

# Always run relative to this script's directory (the project root).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
API_URL="http://localhost:8080"
UI_URL="http://localhost:5173"

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Prerequisite checks ─────────────────────────────────────────────────────
check_prereqs() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed or not on PATH."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose ...)."
  command -v node >/dev/null 2>&1 || die "Node.js is not installed."
  command -v npm  >/dev/null 2>&1 || die "npm is not installed."
}

# ── Start the databases and wait until Postgres is healthy ──────────────────
infra_up() {
  log "Starting Docker infra (Postgres + redis-0/1/2)..."
  docker compose up -d
  log "Waiting for Postgres to become healthy..."
  for _ in $(seq 1 60); do
    status="$(docker inspect -f '{{.State.Health.Status}}' typeahead-postgres 2>/dev/null || echo unknown)"
    [ "$status" = "healthy" ] && { ok "Postgres healthy."; return 0; }
    sleep 1
  done
  die "Postgres did not become healthy in time. Check: docker compose logs postgres"
}

# ── One-time setup: install deps, generate the dataset, ingest into Postgres ─
do_setup() {
  check_prereqs
  infra_up

  log "Installing backend dependencies..."
  (cd "$BACKEND" && npm install)
  ok "Backend deps installed."

  log "Installing frontend dependencies..."
  (cd "$FRONTEND" && npm install)
  ok "Frontend deps installed."

  if [ ! -f "$ROOT/data/queries.csv" ]; then
    log "Generating dataset (~162k Zipfian rows → data/queries.csv)..."
    (cd "$BACKEND" && npm run dataset)
  else
    ok "Dataset already present (data/queries.csv) — skipping generation."
  fi

  log "Ingesting dataset into Postgres..."
  (cd "$BACKEND" && npm run ingest)
  ok "Setup complete."
}

start_api()  { log "Starting API on $API_URL  (Ctrl-C to stop)"; (cd "$BACKEND" && npm run dev); }
start_ui()   { log "Starting UI on $UI_URL  (Ctrl-C to stop)"; (cd "$FRONTEND" && npm run dev); }

# ── Start API + UI together; Ctrl-C cleans up both ──────────────────────────
start_dev() {
  infra_up
  log "Starting API (:8080) and UI (:5173) together. Press Ctrl-C to stop both."
  (cd "$BACKEND" && npm run dev) &
  API_PID=$!
  (cd "$FRONTEND" && npm run dev) &
  UI_PID=$!
  # On Ctrl-C, kill both child process groups.
  trap 'echo; log "Stopping..."; kill "$API_PID" "$UI_PID" 2>/dev/null || true; wait 2>/dev/null || true; ok "Stopped."' INT TERM
  ok "API → $API_URL   UI → $UI_URL"
  wait
}

case "${1:-all}" in
  setup) do_setup ;;
  up)    check_prereqs; infra_up ;;
  api)   start_api ;;
  ui)    start_ui ;;
  dev)   check_prereqs; start_dev ;;
  bench) log "Running benchmark (API must be running)..."; (cd "$BACKEND" && npm run bench) ;;
  test)  log "Running backend unit tests..."; (cd "$BACKEND" && npm test) ;;
  down)  log "Stopping infra (data preserved)..."; docker compose down; ok "Infra stopped." ;;
  reset) log "Stopping infra AND wiping the database volume..."; docker compose down -v; ok "Reset done — run './run.sh setup' next." ;;
  all)
    do_setup
    start_dev
    ;;
  *) die "Unknown command '${1}'. Run with no args, or: setup|up|api|ui|dev|bench|test|down|reset" ;;
esac
