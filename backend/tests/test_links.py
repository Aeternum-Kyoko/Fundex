from __future__ import annotations

import unittest

from app.services.links import exchange_trade_url


class LinkBuilderTests(unittest.TestCase):
    def test_delta_trade_url_uses_base_and_symbol_segments(self) -> None:
        self.assertEqual(
            exchange_trade_url("delta", "BLURUSD"),
            "https://www.delta.exchange/app/futures/trade/BLUR/BLURUSD",
        )
