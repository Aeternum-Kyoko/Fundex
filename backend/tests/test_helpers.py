from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.models.market import ArbitrageOpportunity, FundingSnapshot, OpportunityLeg


DISPLAY_NAMES = {
    "binance": "Binance",
    "delta": "Delta Exchange India",
    "coindcx": "CoinDCX",
    "coinswitch": "CoinSwitch",
}


def make_snapshot(
    *,
    exchange: str,
    canonical_symbol: str = "BTC-USDT-PERP",
    exchange_symbol: str | None = None,
    funding_rate: float = 0.001,
    open_interest_usd: float | None = 2_000_000,
    mark_price: float | None = 100_000,
    fetched_at: datetime | None = None,
    next_funding_time: datetime | None = None,
    quote_asset: str = "USDT",
    funding_interval_hours: int = 8,
    taker_fee_bps: float = 5,
) -> FundingSnapshot:
    base_asset = canonical_symbol.split("-")[0]
    symbol = exchange_symbol or (f"{base_asset}USDT" if exchange == "binance" else f"{base_asset}USD")
    return FundingSnapshot(
        exchange=exchange,
        exchange_symbol=symbol,
        canonical_symbol=canonical_symbol,
        base_asset=base_asset,
        quote_asset=quote_asset,
        funding_rate=funding_rate,
        funding_interval_hours=funding_interval_hours,
        mark_price=mark_price,
        index_price=mark_price,
        open_interest_usd=open_interest_usd,
        next_funding_time=next_funding_time or datetime.now(timezone.utc) + timedelta(hours=1),
        maker_fee_bps=2,
        taker_fee_bps=taker_fee_bps,
        fetched_at=fetched_at or datetime.now(timezone.utc),
    )


def make_opportunity(
    *,
    canonical_symbol: str = "BTC-USDT-PERP",
    long_exchange: str = "delta",
    short_exchange: str = "binance",
    long_symbol: str | None = None,
    short_symbol: str | None = None,
    long_rate: float = -0.001,
    short_rate: float = 0.002,
    spread_rate: float | None = None,
    confidence_score: float = 0.9,
    combined_open_interest_usd: float | None = 2_000_000,
    max_leg_age_seconds: float | None = 10,
    updated_at: datetime | None = None,
) -> ArbitrageOpportunity:
    base_asset = canonical_symbol.split("-")[0]
    now = datetime.now(timezone.utc)
    next_funding = now + timedelta(hours=1)
    spread = spread_rate if spread_rate is not None else short_rate - long_rate

    def default_symbol(exchange: str) -> str:
        if exchange == "delta":
            return f"{base_asset}USD"
        if exchange == "coindcx":
            return f"B-{base_asset}_USDT"
        return f"{base_asset}USDT"

    long_leg = OpportunityLeg(
        exchange=long_exchange,
        display_name=DISPLAY_NAMES.get(long_exchange, long_exchange.title()),
        exchange_symbol=long_symbol or default_symbol(long_exchange),
        funding_rate=long_rate,
        mark_price=100.0,
        open_interest_usd=(combined_open_interest_usd or 0) / 2 if combined_open_interest_usd else None,
        volume_24h=1_000_000,
        taker_fee_bps=5,
        next_funding_time=next_funding,
        trade_url="https://example.com/long",
    )
    short_leg = OpportunityLeg(
        exchange=short_exchange,
        display_name=DISPLAY_NAMES.get(short_exchange, short_exchange.title()),
        exchange_symbol=short_symbol or default_symbol(short_exchange),
        funding_rate=short_rate,
        mark_price=100.2,
        open_interest_usd=(combined_open_interest_usd or 0) / 2 if combined_open_interest_usd else None,
        volume_24h=1_000_000,
        taker_fee_bps=5,
        next_funding_time=next_funding,
        trade_url="https://example.com/short",
    )
    return ArbitrageOpportunity(
        canonical_symbol=canonical_symbol,
        base_asset=base_asset,
        quote_asset="USDT",
        long_leg=long_leg,
        short_leg=short_leg,
        spread_rate=spread,
        spread_rate_hourly=spread / 8,
        funding_interval_hours=8,
        gross_apr_percent=spread * 3 * 365 * 100,
        net_apr_percent=15.0,
        estimated_round_trip_fee_percent=0.2,
        estimated_slippage_percent=0.05,
        estimated_total_cost_percent=0.3,
        holding_horizon_hours=168,
        expected_funding_percent=spread * 100 * 21,
        net_return_percent=spread * 100 * 21 - 0.3,
        combined_open_interest_usd=combined_open_interest_usd,
        price_dislocation_percent=0.1,
        max_leg_age_seconds=max_leg_age_seconds,
        confidence_score=confidence_score,
        warnings=[],
        updated_at=updated_at or now,
    )
