from __future__ import annotations

import asyncio
import hmac

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from app.services.credentials import CREDENTIAL_BENEFITS
from app.services.links import exchange_display_name

router = APIRouter(prefix="/admin")


class CredentialInput(BaseModel):
    api_key: str = Field(min_length=8, max_length=512)
    api_secret: str = Field(min_length=8, max_length=1024)
    extra: dict[str, str] = Field(default_factory=dict)


async def require_admin(request: Request, x_admin_token: str | None = Header(default=None)) -> None:
    expected = request.app.state.settings.admin_token
    if not expected:
        raise HTTPException(status_code=503, detail="Admin is disabled. Set ADMIN_TOKEN in the backend environment.")
    if not x_admin_token or not hmac.compare_digest(x_admin_token.encode(), expected.encode()):
        # Slow down guessing without blocking the event loop.
        await asyncio.sleep(1.0)
        raise HTTPException(status_code=401, detail="Invalid admin token.")


def _engine(request: Request):
    return request.app.state.market_engine


@router.get("/status")
async def admin_status(request: Request) -> dict:
    settings = request.app.state.settings
    return {
        "admin_enabled": bool(settings.admin_token),
        "encryption_ready": _engine(request).credential_store.ready,
    }


@router.get("/credentials", dependencies=[Depends(require_admin)])
async def list_credentials(request: Request) -> dict:
    engine = _engine(request)
    stored = await engine.credential_store.summaries()
    exchanges = []
    for exchange, info in CREDENTIAL_BENEFITS.items():
        summary = stored.get(exchange)
        exchanges.append(
            {
                "exchange": exchange,
                "display_name": exchange_display_name(exchange),  # type: ignore[arg-type]
                "accepts_keys": info["accepts_keys"],
                "benefit": info["benefit"],
                "configured": summary is not None,
                **(summary or {}),
            }
        )
    return {
        "encryption_ready": engine.credential_store.ready,
        "taker_fee_overrides_bps": engine.ranking_context.taker_fee_overrides_bps,
        "exchanges": exchanges,
    }


def _accepting(exchange: str) -> None:
    info = CREDENTIAL_BENEFITS.get(exchange)
    if info is None:
        raise HTTPException(status_code=404, detail="Unknown exchange.")
    if not info["accepts_keys"]:
        raise HTTPException(status_code=400, detail=str(info["benefit"]))


@router.put("/credentials/{exchange}", dependencies=[Depends(require_admin)])
async def save_credentials(request: Request, exchange: str, payload: CredentialInput) -> dict:
    _accepting(exchange)
    engine = _engine(request)
    if not engine.credential_store.ready:
        raise HTTPException(status_code=503, detail="CREDENTIALS_ENCRYPTION_KEY is not set, so keys cannot be stored safely.")
    extra = {key: value for key, value in payload.extra.items() if key in {"exchange"} and value}
    await engine.credential_store.set(exchange, payload.api_key.strip(), payload.api_secret.strip(), extra)
    return await engine.apply_credentials(exchange)


@router.post("/credentials/{exchange}/verify", dependencies=[Depends(require_admin)])
async def verify_credentials(request: Request, exchange: str) -> dict:
    _accepting(exchange)
    return await _engine(request).apply_credentials(exchange)


@router.delete("/credentials/{exchange}", dependencies=[Depends(require_admin)])
async def delete_credentials(request: Request, exchange: str) -> dict:
    _accepting(exchange)
    engine = _engine(request)
    await engine.credential_store.delete(exchange)
    return await engine.apply_credentials(exchange)
