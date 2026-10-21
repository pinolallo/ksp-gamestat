#!/bin/bash
# deploy-mac.sh — install / manage KSP GameStats as a macOS LaunchAgent
#
# Usage:
#   ./deploy-mac.sh install     Install and start the service
#   ./deploy-mac.sh uninstall   Stop and remove the service
#   ./deploy-mac.sh start       Start the service
#   ./deploy-mac.sh stop        Stop the service
#   ./deploy-mac.sh restart     Restart the service
#   ./deploy-mac.sh status      Show running status
#   ./deploy-mac.sh logs        Tail the live log
#   ./deploy-mac.sh open        Open dashboard in default browser

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
LABEL="com.sdipietro.ksp-gamestat"
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/ksp-gamestat"
PORT="${KSP_PORT:-4999}"
DB_PATH="$HOME/.ksp-gamestat/ksp_stats.db"
URL="http://127.0.0.1:${PORT}"

# Resolve node at deploy time (supports nvm, Homebrew, system)
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
    echo "❌ node not found. Install Node.js first: https://nodejs.org" >&2
    exit 1
fi

# ── Helpers ─────────────────────────────────────────────────────────────────
_is_loaded() {
    launchctl list "$LABEL" &>/dev/null
}

_pid() {
    launchctl list "$LABEL" 2>/dev/null | awk '/PID/{print $1}' | grep -v '^-$' || true
}

_write_plist() {
    mkdir -p "$LOG_DIR"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
    "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${INSTALL_DIR}/server/server.js</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>KSP_PORT</key>    <string>${PORT}</string>
        <key>KSP_DB_PATH</key> <string>${DB_PATH}</string>
        <key>NODE_ENV</key>    <string>production</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>

    <key>RunAtLoad</key>  <true/>
    <key>KeepAlive</key>  <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/server.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/server-error.log</string>

    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
PLIST
}

# ── Commands ─────────────────────────────────────────────────────────────────
cmd_install() {
    echo "📦 Installing KSP GameStats service…"

    if [[ ! -d "$INSTALL_DIR/node_modules" ]]; then
        echo "   Installing npm dependencies…"
        npm --prefix "$INSTALL_DIR" install --omit=dev --silent
    fi

    _write_plist
    echo "   Plist written → $PLIST"

    if _is_loaded; then
        launchctl unload "$PLIST" 2>/dev/null || true
    fi
    launchctl load -w "$PLIST"

    # Wait up to 5 s for the server to answer
    echo "   Waiting for server…"
    for i in $(seq 1 20); do
        if curl -sf "$URL/api/health" &>/dev/null; then break; fi
        sleep 0.25
    done

    if curl -sf "$URL/api/health" &>/dev/null; then
        echo "✅ Service running at $URL"
        echo "   Logs: $LOG_DIR/"
        echo ""
        open "$URL"
    else
        echo "⚠️  Service loaded but health check timed out."
        echo "   Check logs: tail -f $LOG_DIR/server-error.log"
    fi
}

cmd_uninstall() {
    echo "🗑  Removing KSP GameStats service…"
    if _is_loaded; then
        launchctl unload -w "$PLIST" 2>/dev/null || true
        echo "   Service stopped."
    fi
    if [[ -f "$PLIST" ]]; then
        rm "$PLIST"
        echo "   Plist removed."
    fi
    echo "✅ Uninstalled. Data and logs preserved in:"
    echo "   DB:   $DB_PATH"
    echo "   Logs: $LOG_DIR/"
}

cmd_start() {
    if _is_loaded; then
        echo "ℹ️  Already running (pid $(_pid)). Use 'restart' to reload."
        return
    fi
    if [[ ! -f "$PLIST" ]]; then
        echo "❌ Not installed yet. Run: $0 install" >&2; exit 1
    fi
    launchctl load -w "$PLIST"
    echo "✅ Started → $URL"
}

cmd_stop() {
    if ! _is_loaded; then
        echo "ℹ️  Service not running."
        return
    fi
    launchctl unload "$PLIST"
    echo "✅ Stopped."
}

cmd_restart() {
    cmd_stop
    sleep 0.5
    cmd_start
}

cmd_status() {
    if ! _is_loaded; then
        echo "🔴 KSP GameStats is NOT running."
        return
    fi
    local pid; pid="$(_pid)"
    echo "🟢 KSP GameStats is running"
    echo "   PID:  ${pid:-unknown}"
    echo "   URL:  $URL"
    echo "   DB:   $DB_PATH"
    echo "   Log:  $LOG_DIR/server.log"
    if curl -sf "$URL/api/health" &>/dev/null; then
        echo "   Health: OK ✅"
    else
        echo "   Health: ⚠️  not responding"
    fi
}

cmd_logs() {
    tail -f "$LOG_DIR/server.log" "$LOG_DIR/server-error.log" 2>/dev/null \
        || { echo "No logs yet at $LOG_DIR/"; exit 1; }
}

cmd_open() {
    open "$URL"
}

# ── Dispatch ─────────────────────────────────────────────────────────────────
CMD="${1:-help}"
case "$CMD" in
    install)   cmd_install   ;;
    uninstall) cmd_uninstall ;;
    start)     cmd_start     ;;
    stop)      cmd_stop      ;;
    restart)   cmd_restart   ;;
    status)    cmd_status    ;;
    logs)      cmd_logs      ;;
    open)      cmd_open      ;;
    *)
        echo "KSP GameStats — macOS deploy script"
        echo ""
        echo "Usage: $(basename "$0") <command>"
        echo ""
        echo "  install     Install as LaunchAgent (auto-start at login) and open browser"
        echo "  uninstall   Stop and remove the LaunchAgent"
        echo "  start       Start the service"
        echo "  stop        Stop the service"
        echo "  restart     Restart the service"
        echo "  status      Show running status + health check"
        echo "  logs        Tail live log output"
        echo "  open        Open dashboard in browser"
        echo ""
        echo "URL: $URL   DB: $DB_PATH"
        ;;
esac
