from __future__ import annotations

import unittest

from app.services.symbol_registry import normalize_exchange_symbol


class SymbolRegistryTests(unittest.TestCase):
    def test_delta_usd_normalizes_to_usdt_canonical(self) -> None:
        identity = normalize_exchange_symbol("delta", "SOLUSD", base_asset_hint="SOL")
        self.assertEqual(identity.canonical_symbol, "SOL-USDT-PERP")
        self.assertEqual(identity.base_asset, "SOL")
        self.assertEqual(identity.quote_asset, "USDT")
        self.assertEqual(identity.source_quote_asset, "USD")

    def test_coindcx_prefixed_symbol_keeps_leading_b_in_base(self) -> None:
        identity = normalize_exchange_symbol("coindcx", "B-BLUR_USDT")
        self.assertEqual(identity.base_asset, "BLUR")
        self.assertEqual(identity.canonical_symbol, "BLUR-USDT-PERP")

    def test_base_alias_xbt_maps_to_btc(self) -> None:
        identity = normalize_exchange_symbol("delta", "XBTUSD")
        self.assertEqual(identity.base_asset, "BTC")
        self.assertEqual(identity.canonical_symbol, "BTC-USDT-PERP")
