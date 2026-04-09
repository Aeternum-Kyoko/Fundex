from __future__ import annotations

import unittest

from app.services.links import exchange_trade_url


class LinkBuilderTests(unittest.TestCase):
    def test_delta_trade_url_uses_base_and_symbol_segments(self) -> None:
        self.assertEqual(
            exchange_trade_url("delta", "BLURUSD"),
            "https://www.delta.exchange/app/futures/trade/BLUR/BLURUSD",
        )

    def test_coinswitch_trade_url_uses_symbol_deep_link(self) -> None:
        self.assertEqual(
            exchange_trade_url("coinswitch", "BTCUSDT"),
            "https://coinswitch.co/pro/futures-perpetual/BTCUSDT",
        )
