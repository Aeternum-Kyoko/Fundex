from __future__ import annotations

from dataclasses import dataclass
import re

from app.models.market import ExchangeName


KNOWN_QUOTES = ("USDT", "USD", "USDC", "FDUSD", "INR", "BTC", "ETH")
DEFAULT_EXCHANGE_QUOTES: dict[ExchangeName, str] = {
    "binance": "USDT",
    "delta": "USD",
    "coindcx": "USDT",
    "coinswitch": "INR",
}
STABLE_QUOTE_ALIASES = {
    "USD": "USDT",
    "USDT": "USDT",
    "USDC": "USDT",
    "FDUSD": "USDT",
}
BASE_ALIASES = {
    "XBT": "BTC",
}


@dataclass(frozen=True)
class SymbolIdentity:
    canonical_symbol: str
    base_asset: str
    quote_asset: str
    source_quote_asset: str


@dataclass(frozen=True)
class SymbolQuery:
    raw: str
    uppercase: str
    compact: str


def canonical_symbol(base_asset: str, quote_asset: str, instrument_type: str = "PERP") -> str:
    return f"{base_asset.upper()}-{quote_asset.upper()}-{instrument_type.upper()}"


def normalize_exchange_symbol(
    exchange: ExchangeName,
    raw_symbol: str,
    *,
    base_asset_hint: str | None = None,
    quote_asset_hint: str | None = None,
) -> SymbolIdentity:
    parsed_base, parsed_quote = _split_symbol(raw_symbol)

    hinted_base = _normalize_base_asset(base_asset_hint) if base_asset_hint else None
    hinted_quote = _clean_quote_asset(quote_asset_hint) if quote_asset_hint else None

    resolved_base = hinted_base or parsed_base
    source_quote_asset = hinted_quote or parsed_quote or DEFAULT_EXCHANGE_QUOTES.get(exchange, "USDT")
    normalized_quote_asset = _normalize_quote_asset(source_quote_asset)

    if exchange == "delta" and normalized_quote_asset == "USDT":
        # Delta contracts often come through as `...USD`, but economically map to the USDT perp view in this app.
        source_quote_asset = source_quote_asset or "USD"

    return SymbolIdentity(
        canonical_symbol=canonical_symbol(resolved_base, normalized_quote_asset),
        base_asset=resolved_base,
        quote_asset=normalized_quote_asset,
        source_quote_asset=source_quote_asset,
    )


def normalize_symbol_query(query: str) -> SymbolQuery:
    uppercase = query.strip().upper()
    return SymbolQuery(
        raw=query,
        uppercase=uppercase,
        compact=_compact_freeform_symbol(uppercase),
    )


def build_symbol_aliases(canonical_symbol: str, base_asset: str, exchange_symbols: list[str] | tuple[str, ...]) -> set[str]:
    aliases = {
        canonical_symbol.upper(),
        _compact_freeform_symbol(canonical_symbol),
        _normalize_base_asset(base_asset),
    }

    for exchange_symbol in exchange_symbols:
        if not exchange_symbol:
            continue
        aliases.add(exchange_symbol.upper())
        aliases.add(_compact_symbol(exchange_symbol))

    return {alias for alias in aliases if alias}


def _compact_symbol(raw_symbol: str) -> str:
    original = raw_symbol.upper().strip()
    compact = _compact_freeform_symbol(original)

    # CoinDCX style prefixed forms like `B-BTC_USDT`
    if original.startswith("B-") or original.startswith("B_"):
        compact = compact[1:]

    return compact


def _split_symbol(raw_symbol: str) -> tuple[str, str]:
    symbol = _compact_symbol(raw_symbol)
    for quote in sorted(KNOWN_QUOTES, key=len, reverse=True):
        if symbol.endswith(quote) and len(symbol) > len(quote):
            base = symbol[: -len(quote)]
            return _normalize_base_asset(base), quote
    return _normalize_base_asset(symbol), "USDT"


def _compact_freeform_symbol(raw_symbol: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", raw_symbol.upper().strip())


def _normalize_base_asset(base_asset: str) -> str:
    cleaned = re.sub(r"[^A-Z0-9]", "", base_asset.upper())
    return BASE_ALIASES.get(cleaned, cleaned)


def _clean_quote_asset(quote_asset: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", quote_asset.upper())


def _normalize_quote_asset(quote_asset: str) -> str:
    cleaned = _clean_quote_asset(quote_asset)
    return STABLE_QUOTE_ALIASES.get(cleaned, cleaned or "USDT")
