from __future__ import annotations

import unittest

from app.adapters.coinswitch import CoinSwitchAdapter


class CoinSwitchAdapterTests(unittest.TestCase):
    def test_to_float_returns_none_for_empty_string(self) -> None:
        self.assertIsNone(CoinSwitchAdapter._to_float(""))
        self.assertIsNone(CoinSwitchAdapter._to_float(None))

    def test_to_float_parses_numeric_strings(self) -> None:
        self.assertEqual(CoinSwitchAdapter._to_float("1.25"), 1.25)
