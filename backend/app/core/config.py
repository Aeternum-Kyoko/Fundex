from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.models.market import ExchangeName


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Fundex API"
    app_env: str = "development"
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"])

    default_poll_interval_seconds: int = 12
    default_history_limit: int = 48
    min_confidence_score: float = 0.35
    min_combined_oi_usd: float = 500_000
    max_price_dislocation_percent: float = 0.75
    # Pairs whose mark prices differ by more than this are almost certainly different instruments
    # (e.g. a 1000x-denominated contract), so they are dropped instead of ranked.
    max_pair_price_dislocation_percent: float = 3.0
    # Net return / net APR assume the hedge is held this long (entry + exit costs paid once).
    holding_horizon_hours: int = 168
    # Order-book slippage is measured for this position size per leg (USD notional).
    liquidity_reference_notional_usd: float = 1_000
    liquidity_top_n: int = 40
    liquidity_max_age_seconds: float = 120
    # Admin API (exchange keys). Disabled unless ADMIN_TOKEN is set; keys need CREDENTIALS_ENCRYPTION_KEY.
    admin_token: str | None = None
    credentials_encryption_key: str | None = None

    binance_enabled: bool = True
    delta_enabled: bool = True
    coindcx_enabled: bool = False
    coindcx_api_key: str | None = None
    coindcx_secret_key: str | None = None
    wazirx_enabled: bool = False
    coinswitch_enabled: bool = False
    coinswitch_api_key: str | None = None
    coinswitch_secret_key: str | None = None
    coinswitch_exchange: str = "EXCHANGE_2"
    telegram_enabled: bool = False
    telegram_bot_token: str | None = None
    telegram_chat_id: str | None = None
    telegram_chat_ids: list[str] = Field(default_factory=list)
    telegram_min_spread_percent: float = 0.05
    telegram_min_confidence_score: float = 0.55
    # Next-settlement alerts: sent this many minutes before a settlement whose capture nets at least the threshold.
    telegram_capture_alerts_enabled: bool = True
    telegram_capture_lead_minutes: int = 10
    telegram_min_capture_net_percent: float = 0.0
    # Message the alert chats when a paper or live trade finishes, settles, or fails.
    telegram_trade_notifications: bool = True
    telegram_min_combined_oi_usd: float = 1_000_000
    telegram_max_staleness_seconds: int = 45
    telegram_top_n: int = 5
    telegram_cooldown_minutes: int = 30
    telegram_poll_interval_seconds: int = 8
    telegram_daily_summary_enabled: bool = True
    telegram_daily_summary_timezone: str = "Asia/Kolkata"
    telegram_daily_summary_top_n: int = 5
    telegram_morning_summary_enabled: bool = True
    telegram_morning_summary_hour: int = 9
    telegram_morning_summary_minute: int = 0
    telegram_evening_summary_enabled: bool = True
    telegram_evening_summary_hour: int = 18
    telegram_evening_summary_minute: int = 0
    telegram_night_summary_enabled: bool = True
    telegram_night_summary_hour: int = 22
    telegram_night_summary_minute: int = 0
    retention_prune_interval_minutes: int = 5
    funding_snapshot_retention_hours: int = 24
    opportunity_history_retention_days: int = 1
    telegram_alert_state_retention_days: int = 30
    database_path: str = "data/arbradar.db"

    @property
    def database_file(self) -> Path:
        return Path(self.database_path)

    @property
    def coinswitch_configured(self) -> bool:
        return bool(self.coinswitch_api_key and self.coinswitch_secret_key)

    @property
    def resolved_telegram_chat_ids(self) -> list[str]:
        resolved = [chat_id.strip() for chat_id in self.telegram_chat_ids if chat_id and chat_id.strip()]
        if self.telegram_chat_id and self.telegram_chat_id.strip():
            resolved.append(self.telegram_chat_id.strip())
        return list(dict.fromkeys(resolved))

    @property
    def enabled_exchange_names(self) -> list[ExchangeName]:
        exchanges: list[ExchangeName] = []
        if self.binance_enabled:
            exchanges.append("binance")
        if self.delta_enabled:
            exchanges.append("delta")
        if self.coindcx_enabled:
            exchanges.append("coindcx")
        if self.coinswitch_enabled and self.coinswitch_configured:
            exchanges.append("coinswitch")
        if self.wazirx_enabled:
            exchanges.append("wazirx")
        return exchanges


@lru_cache
def get_settings() -> Settings:
    return Settings()
