#!/usr/bin/env bash
# build-backend.sh — Build the SideAI Python backend into a standalone executable.
# Output: sideai/backend-dist/sideai-backend/
# Requirements: Python 3.10+, the backend venv must already be set up (npm run install:backend).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
BACKEND="$ROOT/backend"
OUT="$ROOT/backend-dist"

echo "▶ Building SideAI backend with PyInstaller..."

# Ensure pyinstaller is available in the venv
PYTHON="$BACKEND/venv/bin/python"
if [ ! -f "$PYTHON" ]; then
  echo "❌ Backend venv not found. Run: npm run install:backend"
  exit 1
fi

# Install pyinstaller into the venv if missing
"$PYTHON" -c "import PyInstaller" 2>/dev/null || {
  echo "  Installing PyInstaller..."
  "$BACKEND/venv/bin/pip" install pyinstaller --quiet
}

# Clean previous build artefacts
rm -rf "$BACKEND/build" "$BACKEND/dist" "$OUT"
mkdir -p "$OUT"

cd "$BACKEND"
"$BACKEND/venv/bin/pyinstaller" sideai.spec \
  --distpath "$OUT" \
  --workpath "$BACKEND/build" \
  --noconfirm \
  --clean

echo "✅ Backend built: $OUT/sideai-backend/"

# --- Optional: bundle Tesseract for macOS --------------------------------
# Uncomment the block below if you have a static Tesseract binary to bundle.
# Download from: https://github.com/UB-Mannheim/tesseract/releases (macOS arm64 / x64)
# Place the binary + tessdata at: sideai/assets/tesseract/
#
# TESSDIR="$ROOT/assets/tesseract"
# if [ -d "$TESSDIR" ]; then
#   echo "  Bundling Tesseract from $TESSDIR"
# else
#   echo "  ⚠️  No bundled Tesseract found at $TESSDIR."
#   echo "     The app will fall back to the system Tesseract (brew install tesseract)."
# fi
