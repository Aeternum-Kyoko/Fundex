from __future__ import annotations

from app.services.symbol_registry import canonical_symbol, normalize_exchange_symbol


def split_symbol(raw_symbol: str) -> tuple[str, str]:
    identity = normalize_exchange_symbol("binance", raw_symbol)
    return identity.base_asset, identity.source_quote_asset


def canonicalize(raw_symbol: str, *, base_asset: str | None = None, quote_asset: str | None = None) -> tuple[str, str, str]:
    identity = normalize_exchange_symbol(
        "binance",
        raw_symbol,
        base_asset_hint=base_asset,
        quote_asset_hint=quote_asset,
    )
    return identity.canonical_symbol, identity.base_asset, identity.quote_asset
