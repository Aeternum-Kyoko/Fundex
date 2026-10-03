from __future__ import annotations

from app.models.market import ExchangeName


DISPLAY_NAMES: dict[ExchangeName, str] = {
    "binance": "Binance",
    "delta": "Delta Exchange India",
    "coindcx": "CoinDCX",
    "coinswitch": "CoinSwitch",
    "wazirx": "WazirX",
}


def exchange_display_name(exchange: ExchangeName) -> str:
    return DISPLAY_NAMES[exchange]


def exchange_trade_url(exchange: ExchangeName, exchange_symbol: str) -> str:
    symbol = exchange_symbol.upper()
    if exchange == "binance":
        return f"https://www.binance.com/en/futures/{symbol}"
    if exchange == "delta":
        base_asset = symbol
        for quote in ("USDT", "USD"):
            if symbol.endswith(quote) and len(symbol) > len(quote):
                base_asset = symbol[: -len(quote)]
                break
        return f"https://www.delta.exchange/app/futures/trade/{base_asset}/{symbol}"
    if exchange == "coindcx":
        return "https://coindcx.com/crypto-futures/"
    if exchange == "coinswitch":
        return f"https://coinswitch.co/pro/futures-perpetual/{symbol}"
    if exchange == "wazirx":
        return "https://wazirx.com/futures"
    return "#"
