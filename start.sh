#!/bin/bash
set -e

PORT="${KSP_PORT:-4999}"

echo "=================================="
echo "  KSP GameStats - Mission Control"
echo "=================================="
echo ""

if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Install it from https://nodejs.org"
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

echo "🚀 Starting server on http://127.0.0.1:${PORT}"
echo "   Press Ctrl+C to stop."
echo ""

open "http://127.0.0.1:${PORT}" 2>/dev/null &

KSP_PORT="$PORT" node server/server.js
