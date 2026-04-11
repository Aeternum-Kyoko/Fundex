from __future__ import annotations

import unittest
from httpx import AsyncClient

from app.adapters.coinswitch import CoinSwitchAdapter


class CoinSwitchAdapterTests(unittest.TestCase):
    def test_to_float_returns_none_for_empty_string(self) -> None:
        self.assertIsNone(CoinSwitchAdapter._to_float(""))
        self.assertIsNone(CoinSwitchAdapter._to_float(None))

    def test_to_float_parses_numeric_strings(self) -> None:
        self.assertEqual(CoinSwitchAdapter._to_float("1.25"), 1.25)

    def test_extract_max_leverage_prefers_explicit_fields(self) -> None:
        self.assertEqual(CoinSwitchAdapter._extract_max_leverage({"max_leverage": "25"}), 25.0)
        self.assertEqual(CoinSwitchAdapter._extract_max_leverage({"allowed_leverage": "20"}), 20.0)

    def test_extract_max_leverage_returns_none_when_missing(self) -> None:
        self.assertIsNone(CoinSwitchAdapter._extract_max_leverage({}))

    def test_fetch_snapshot_can_fall_back_to_instrument_metadata_leverage(self) -> None:
        adapter = CoinSwitchAdapter(AsyncClient(), settings=None)
        adapter._instrument_metadata = {"BTCUSDT": {"max_leverage": 50.0}}

        item = {
            "funding_rate": "0.0005",
            "mark_price": "95000",
        }

        leverage = adapter._extract_max_leverage(item) or adapter._to_float(adapter._instrument_metadata["BTCUSDT"]["max_leverage"])
        self.assertEqual(leverage, 50.0)
