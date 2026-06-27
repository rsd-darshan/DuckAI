#!/usr/bin/env bash
# build-app.sh — Full production build pipeline for SideAI.
# Produces a signed/unsigned .dmg in sideai/dist-app/
#
# Usage:
#   bash scripts/build-app.sh               # unsigned (local testing)
#   SIGN=1 bash scripts/build-app.sh        # signed (requires Apple developer certs in keychain)
#
# Required env vars for signed + notarized builds:
#   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
#   CSC_LINK (base64-encoded .p12), CSC_KEY_PASSWORD
#
# Optional (for managed AI tier):
#   SIDEAI_MANAGED_GROQ_KEY   — bundled Groq API key for free-tier users
#   SIDEAI_MANAGED_HF_TOKEN   — bundled HF token (alternative to Groq)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

echo "═══════════════════════════════════"
echo "  SideAI build pipeline"
echo "═══════════════════════════════════"

# ── 1. Frontend ──────────────────────────────────────────────────────────────
echo ""
echo "▶ Step 1/4 — Building frontend..."
cd "$ROOT/frontend"
npm install --silent
npm run build
echo "  ✅ Frontend built: frontend/dist/"

# ── 2. Backend ───────────────────────────────────────────────────────────────
echo ""
echo "▶ Step 2/4 — Building Python backend..."
cd "$ROOT"
bash scripts/build-backend.sh

# ── 3. Electron deps ─────────────────────────────────────────────────────────
echo ""
echo "▶ Step 3/4 — Installing Electron dependencies..."
cd "$ROOT/electron"
npm install --silent
cd "$ROOT"
npm install --silent   # for electron-builder at root

# ── 4. Package with electron-builder ─────────────────────────────────────────
echo ""
echo "▶ Step 4/4 — Packaging with electron-builder..."

if [ "${SIGN:-0}" = "1" ]; then
  electron-builder --mac --config electron-builder.json
else
  # Skip code signing for unsigned local builds
  CSC_IDENTITY_AUTO_DISCOVERY=false \
  electron-builder --mac --config electron-builder.json \
    --config.mac.identity=null
fi

echo ""
echo "═══════════════════════════════════"
echo "  ✅ Build complete!"
echo "  Output: dist-app/"
echo "═══════════════════════════════════"
