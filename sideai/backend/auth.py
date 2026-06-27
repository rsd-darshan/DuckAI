"""
Clerk JWT verification for SideAI backend.

Clerk signs JWTs with RS256. We fetch the JWKS from Clerk's API,
cache it in-process, and verify incoming Bearer tokens.

Usage in FastAPI routes:
    from auth import get_current_user, OptionalUser

    # Require auth — raises 401 if token missing/invalid
    @app.get("/api/cloud/sync")
    def sync(user = Depends(get_current_user)):
        return {"user_id": user["sub"]}

    # Optional auth — returns None for unauthenticated requests
    @app.get("/api/chat")
    def chat(user = Depends(OptionalUser)):
        ...
"""

import logging
import os
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx
import jwt
from dotenv import load_dotenv
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

load_dotenv(Path(__file__).resolve().parent / ".env")

logger = logging.getLogger("sideai.auth")

CLERK_SECRET_KEY = os.getenv("CLERK_SECRET_KEY", "").strip()
# Derive JWKS URL from the publishable key's instance FQDN, or use the secret key endpoint.
# Clerk JWKS is available at: https://api.clerk.com/v1/jwks  (auth'd with secret key)
CLERK_JWKS_URL = os.getenv("CLERK_JWKS_URL", "https://api.clerk.com/v1/jwks")

_bearer = HTTPBearer(auto_error=False)

# ── JWKS caching ──────────────────────────────────────────────────────────────
_jwks_cache: dict[str, Any] = {}
_jwks_fetched_at: float = 0.0
_JWKS_TTL = 3600  # refresh keys every hour


def _get_jwks() -> dict[str, Any]:
    global _jwks_cache, _jwks_fetched_at
    now = time.monotonic()
    if _jwks_cache and (now - _jwks_fetched_at) < _JWKS_TTL:
        return _jwks_cache

    if not CLERK_SECRET_KEY:
        logger.warning("CLERK_SECRET_KEY not set — auth verification disabled")
        return {}

    try:
        resp = httpx.get(
            CLERK_JWKS_URL,
            headers={"Authorization": f"Bearer {CLERK_SECRET_KEY}"},
            timeout=10.0,
        )
        resp.raise_for_status()
        _jwks_cache = resp.json()
        _jwks_fetched_at = now
        logger.debug("JWKS refreshed: %d key(s)", len(_jwks_cache.get("keys", [])))
    except Exception as e:
        logger.error("Failed to fetch Clerk JWKS: %s", e)
        # Return stale cache if available
        if _jwks_cache:
            return _jwks_cache

    return _jwks_cache


def verify_clerk_token(token: str) -> dict[str, Any]:
    """
    Verify a Clerk-issued JWT and return its payload.
    Raises jwt.PyJWTError on any validation failure.
    """
    if not CLERK_SECRET_KEY:
        raise ValueError("CLERK_SECRET_KEY not configured — set it in backend/.env")

    jwks = _get_jwks()
    if not jwks or not jwks.get("keys"):
        raise ValueError(
            "Could not retrieve signing keys from Clerk. "
            "Check that CLERK_SECRET_KEY is valid and the network is reachable."
        )

    try:
        client = jwt.PyJWKClient(
            CLERK_JWKS_URL,
            headers={"Authorization": f"Bearer {CLERK_SECRET_KEY}"},
            cache_keys=True,
        )
        signing_key = client.get_signing_key_from_jwt(token)
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            options={"verify_exp": True},
        )
        return payload
    except jwt.ExpiredSignatureError:
        raise jwt.ExpiredSignatureError("Token has expired — please sign in again")
    except jwt.InvalidTokenError as e:
        raise jwt.InvalidTokenError(f"Invalid token: {e}")


# ── FastAPI dependency helpers ────────────────────────────────────────────────

def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict[str, Any]:
    """
    FastAPI dependency — requires a valid Clerk JWT.
    Returns the token payload dict (includes 'sub', 'email', etc.).
    Raises HTTP 401 if missing or invalid.
    """
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        return verify_clerk_token(credentials.credentials)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(e),
            headers={"WWW-Authenticate": "Bearer"},
        )


def get_optional_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict[str, Any] | None:
    """
    FastAPI dependency — returns the token payload if a valid JWT is present,
    otherwise returns None. Use for endpoints that work in both auth'd and
    anonymous modes (e.g. chat with different rate limits per tier).
    """
    if credentials is None:
        return None
    try:
        return verify_clerk_token(credentials.credentials)
    except Exception:
        return None


# Convenience alias
OptionalUser = Depends(get_optional_user)
RequireUser = Depends(get_current_user)
