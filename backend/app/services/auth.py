from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any

from fastapi import HTTPException, Request, Response, status

from app.core.config import Settings


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _sign(payload: str, secret: str) -> str:
    return _b64encode(hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).digest())


def auth_is_configured(settings: Settings) -> bool:
    return bool(settings.auth_username and settings.auth_password and settings.auth_session_secret)


def verify_credentials(settings: Settings, username: str, password: str) -> bool:
    expected_username = settings.auth_username or ""
    expected_password = settings.auth_password or ""
    return secrets.compare_digest(username.strip(), expected_username) and secrets.compare_digest(password, expected_password)


def create_session_token(settings: Settings) -> str:
    if not auth_is_configured(settings):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Authentication is not configured.")

    now = int(time.time())
    payload = {
        "sub": settings.auth_username,
        "iat": now,
        "exp": now + settings.auth_session_max_age_seconds,
        "nonce": secrets.token_urlsafe(18),
    }
    encoded_payload = _b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = _sign(encoded_payload, settings.auth_session_secret)
    return f"{encoded_payload}.{signature}"


def read_session_token(settings: Settings, token: str | None) -> dict[str, Any] | None:
    if not token or not auth_is_configured(settings):
        return None

    try:
        encoded_payload, signature = token.split(".", 1)
    except ValueError:
        return None

    expected_signature = _sign(encoded_payload, settings.auth_session_secret)
    if not secrets.compare_digest(signature, expected_signature):
        return None

    try:
        payload = json.loads(_b64decode(encoded_payload))
    except (ValueError, json.JSONDecodeError):
        return None

    if not isinstance(payload, dict):
        return None

    expires_at = payload.get("exp")
    subject = payload.get("sub")
    if not isinstance(expires_at, int) or expires_at < int(time.time()):
        return None
    if subject != settings.auth_username:
        return None

    return payload


def get_session_payload(request: Request) -> dict[str, Any] | None:
    settings: Settings = request.app.state.settings
    token = request.cookies.get(settings.auth_cookie_name)
    return read_session_token(settings, token)


def require_session(request: Request) -> dict[str, Any]:
    payload = get_session_payload(request)
    if payload is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
    return payload


def set_session_cookie(response: Response, settings: Settings, token: str) -> None:
    response.set_cookie(
        key=settings.auth_cookie_name,
        value=token,
        max_age=settings.auth_session_max_age_seconds,
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite=settings.auth_cookie_samesite,
        path="/",
    )


def clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        key=settings.auth_cookie_name,
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite=settings.auth_cookie_samesite,
        path="/",
    )
