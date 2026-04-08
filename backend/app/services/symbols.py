from __future__ import annotations

import re


KNOWN_QUOTES = ("USDT", "USD", "INR", "BTC", "ETH")


def split_symbol(raw_symbol: str) -> tuple[str, str]:
    symbol = raw_symbol.upper()
    symbol = symbol.replace("/", "").replace("-", "").replace("_", "")

    if symbol.startswith("B"):
        symbol = symbol[1:]

    for quote in KNOWN_QUOTES:
        if symbol.endswith(quote) and len(symbol) > len(quote):
            base = symbol[: -len(quote)]
            return base, quote

    cleaned = re.sub(r"[^A-Z0-9]", "", raw_symbol.upper())
    return cleaned, "USDT"


def canonical_symbol(base_asset: str, quote_asset: str, instrument_type: str = "PERP") -> str:
    return f"{base_asset.upper()}-{quote_asset.upper()}-{instrument_type.upper()}"


def canonicalize(raw_symbol: str, *, base_asset: str | None = None, quote_asset: str | None = None) -> tuple[str, str, str]:
    resolved_base, resolved_quote = split_symbol(raw_symbol)
    base = (base_asset or resolved_base).upper()
    quote = (quote_asset or resolved_quote).upper()
    return canonical_symbol(base, quote), base, quote

