# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the SideAI FastAPI backend.
Produces a single-folder distribution: dist/sideai-backend/
The Electron packager then copies the entire folder into the app bundle.
"""

import sys
from pathlib import Path

block_cipher = None
HERE = Path(SPECPATH)  # noqa: F821 — SPECPATH is injected by PyInstaller

a = Analysis(
    ["main.py"],
    pathex=[str(HERE)],
    binaries=[],
    datas=[
        # Include .env.example so first-time users know what keys to set
        (".env.example", "."),
        # Include any tessdata the user has locally (optional; may be empty)
        # Real bundling of Tesseract tessdata is handled separately in build-backend.sh
    ],
    hiddenimports=[
        # FastAPI / Starlette internals not always auto-detected
        "uvicorn.logging",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "starlette.routing",
        "starlette.middleware",
        "starlette.middleware.base",
        "starlette.responses",
        "fastapi.middleware.cors",
        # Optional macOS deps (won't be available cross-platform)
        "pyobjc",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "matplotlib",
        "numpy",
        "pandas",
        "scipy",
        "IPython",
        "jupyter",
        "notebook",
        "pytest",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="sideai-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
)

coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="sideai-backend",
)
