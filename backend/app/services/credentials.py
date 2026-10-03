from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

from cryptography.fernet import Fernet, InvalidToken
from httpx import AsyncClient

# What a key actually adds for each exchange. Venues whose public data is already complete are listed
# so the admin page can say so, but no key is collected for them.
CREDENTIAL_BENEFITS: dict[str, dict[str, object]] = {
    "binance": {
        "accepts_keys": True,
        "benefit": "Uses your account's real taker fee tier in every cost and net-return figure, and checks the key cannot withdraw.",
    },
    "coinswitch": {
        "accepts_keys": True,
        "benefit": "Required: CoinSwitch only serves funding data to authenticated API keys. Adds CoinSwitch to the monitor.",
    },
    "delta": {"accepts_keys": False, "benefit": "Not needed: Delta's public API already gives rates, intervals, open interest and order books."},
    "coindcx": {"accepts_keys": False, "benefit": "Not needed: CoinDCX's public feed already gives predicted rates, intervals and order books."},
    "wazirx": {"accepts_keys": False, "benefit": "Not needed: WazirX's public futures API already gives rates and order books."},
}


@dataclass(frozen=True)
class StoredCredential:
    exchange: str
    api_key: str
    api_secret: str
    extra: dict[str, str]
    updated_at: str


class CredentialStore:
    """Exchange API keys, encrypted at rest with Fernet. Secrets never leave this class unmasked."""

    def __init__(self, database_path: Path, encryption_key: str | None) -> None:
        self.database_path = database_path
        self._fernet = Fernet(encryption_key.encode()) if encryption_key else None
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.database_path) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS exchange_credentials (
                    exchange TEXT PRIMARY KEY,
                    payload BLOB NOT NULL,
                    key_hint TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    verified_at TEXT,
                    verify_status TEXT,
                    verify_message TEXT,
                    verify_details TEXT
                )
                """
            )

    @property
    def ready(self) -> bool:
        return self._fernet is not None

    async def get(self, exchange: str) -> StoredCredential | None:
        return await asyncio.to_thread(self._get_sync, exchange)

    def _get_sync(self, exchange: str) -> StoredCredential | None:
        if not self._fernet:
            return None
        with sqlite3.connect(self.database_path) as connection:
            row = connection.execute("SELECT payload, updated_at FROM exchange_credentials WHERE exchange = ?", (exchange,)).fetchone()
        if not row:
            return None
        try:
            payload = json.loads(self._fernet.decrypt(row[0]))
        except InvalidToken:
            # Encrypted with a different key; treat as absent rather than crash.
            return None
        return StoredCredential(exchange, payload["api_key"], payload["api_secret"], payload.get("extra") or {}, row[1])

    async def set(self, exchange: str, api_key: str, api_secret: str, extra: dict[str, str]) -> None:
        if not self._fernet:
            raise RuntimeError("CREDENTIALS_ENCRYPTION_KEY is not set, so keys cannot be stored safely.")
        token = self._fernet.encrypt(json.dumps({"api_key": api_key, "api_secret": api_secret, "extra": extra}).encode())
        hint = f"…{api_key[-4:]}" if len(api_key) >= 8 else "set"
        now = datetime.now(timezone.utc).isoformat()
        await asyncio.to_thread(self._execute, (
            "INSERT INTO exchange_credentials (exchange, payload, key_hint, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(exchange) DO UPDATE SET payload = excluded.payload, key_hint = excluded.key_hint, "
            "updated_at = excluded.updated_at, verified_at = NULL, verify_status = NULL, verify_message = NULL, verify_details = NULL",
            (exchange, token, hint, now),
        ))

    async def delete(self, exchange: str) -> None:
        await asyncio.to_thread(self._execute, ("DELETE FROM exchange_credentials WHERE exchange = ?", (exchange,)))

    async def record_verification(self, exchange: str, status: str, message: str, details: dict) -> None:
        await asyncio.to_thread(self._execute, (
            "UPDATE exchange_credentials SET verified_at = ?, verify_status = ?, verify_message = ?, verify_details = ? WHERE exchange = ?",
            (datetime.now(timezone.utc).isoformat(), status, message, json.dumps(details), exchange),
        ))

    async def summaries(self) -> dict[str, dict]:
        return await asyncio.to_thread(self._summaries_sync)

    def _summaries_sync(self) -> dict[str, dict]:
        with sqlite3.connect(self.database_path) as connection:
            rows = connection.execute(
                "SELECT exchange, key_hint, updated_at, verified_at, verify_status, verify_message, verify_details FROM exchange_credentials"
            ).fetchall()
        return {
            row[0]: {
                "key_hint": row[1],
                "updated_at": row[2],
                "verified_at": row[3],
                "verify_status": row[4],
                "verify_message": row[5],
                "verify_details": json.loads(row[6]) if row[6] else {},
            }
            for row in rows
        }

    def _execute(self, statement: tuple[str, tuple]) -> None:
        with sqlite3.connect(self.database_path) as connection:
            connection.execute(*statement)


class BinanceAccountProbe:
    """Read-only signed calls that sharpen accuracy: the account's fee tier and the key's permissions."""

    def __init__(self, client: AsyncClient) -> None:
        self.client = client

    async def _signed_get(self, base: str, path: str, credential: StoredCredential, params: dict | None = None) -> dict:
        query = dict(params or {})
        query["timestamp"] = int(time.time() * 1000)
        query["recvWindow"] = 10_000
        encoded = urlencode(query)
        signature = hmac.new(credential.api_secret.encode(), encoded.encode(), hashlib.sha256).hexdigest()
        response = await self.client.get(
            f"{base}{path}?{encoded}&signature={signature}",
            headers={"X-MBX-APIKEY": credential.api_key},
            timeout=15.0,
        )
        if response.status_code >= 400:
            try:
                message = response.json().get("msg") or response.text
            except ValueError:
                message = response.text
            raise PermissionError(f"Binance rejected the key ({response.status_code}): {message}")
        return response.json()

    async def probe(self, credential: StoredCredential) -> tuple[str, str, dict]:
        commission = await self._signed_get("https://fapi.binance.com", "/fapi/v1/commissionRate", credential, {"symbol": "BTCUSDT"})
        taker_bps = float(commission["takerCommissionRate"]) * 10_000
        maker_bps = float(commission["makerCommissionRate"]) * 10_000
        details: dict[str, object] = {"taker_fee_bps": taker_bps, "maker_fee_bps": maker_bps}
        status, message = "verified", f"Fee tier applied: taker {taker_bps / 100:.4f}%, maker {maker_bps / 100:.4f}%."
        try:
            restrictions = await self._signed_get("https://api.binance.com", "/sapi/v1/account/apiRestrictions", credential)
            details["withdrawals_enabled"] = bool(restrictions.get("enableWithdrawals"))
            details["futures_trading_enabled"] = bool(restrictions.get("enableFutures"))
            if details["withdrawals_enabled"]:
                status = "warning"
                message += " This key can WITHDRAW funds; create a read-only key for Fundex instead."
        except PermissionError:
            details["withdrawals_enabled"] = None
            message += " Key permissions could not be read; make sure withdrawals are disabled on this key."
        return status, message, details
