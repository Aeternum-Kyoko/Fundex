from __future__ import annotations

from collections import defaultdict

from app.models.market import ExchangeFundingLeaders, FundingLeader, FundingLeadersResponse, FundingSnapshot
from app.services.links import exchange_display_name, exchange_trade_url


def build_funding_leaders(
    snapshots: list[FundingSnapshot],
    limit: int = 5,
    exchanges_to_include: tuple[str, ...] | None = None,
) -> FundingLeadersResponse:
    grouped: dict[str, list[FundingSnapshot]] = defaultdict(list)
    for snapshot in snapshots:
        grouped[snapshot.exchange].append(snapshot)

    if exchanges_to_include is None:
        exchanges_to_include = tuple(
            exchange
            for exchange in ("binance", "delta", "coindcx", "coinswitch", "wazirx")
            if exchange in grouped
        )

    exchanges: list[ExchangeFundingLeaders] = []
    for exchange in exchanges_to_include:
        entries = grouped.get(exchange, [])
        positive = sorted(
            [snapshot for snapshot in entries if snapshot.funding_rate > 0],
            key=lambda snapshot: snapshot.funding_rate,
            reverse=True,
        )[:limit]
        negative = sorted(
            [snapshot for snapshot in entries if snapshot.funding_rate < 0],
            key=lambda snapshot: snapshot.funding_rate,
        )[:limit]

        exchanges.append(
            ExchangeFundingLeaders(
                exchange=exchange,
                display_name=exchange_display_name(exchange),
                top_positive=[_to_funding_leader(snapshot) for snapshot in positive],
                top_negative=[_to_funding_leader(snapshot) for snapshot in negative],
            )
        )

    return FundingLeadersResponse(total_exchanges=len(exchanges), exchanges=exchanges)


def _to_funding_leader(snapshot: FundingSnapshot) -> FundingLeader:
    return FundingLeader(
        exchange=snapshot.exchange,
        display_name=exchange_display_name(snapshot.exchange),
                canonical_symbol=snapshot.canonical_symbol,
                exchange_symbol=snapshot.exchange_symbol,
                base_asset=snapshot.base_asset,
                funding_rate=snapshot.funding_rate,
                funding_interval_hours=snapshot.funding_interval_hours,
                max_leverage=snapshot.max_leverage,
                next_funding_time=snapshot.next_funding_time,
                mark_price=snapshot.mark_price,
        open_interest_usd=snapshot.open_interest_usd,
        trade_url=exchange_trade_url(snapshot.exchange, snapshot.exchange_symbol),
    )
