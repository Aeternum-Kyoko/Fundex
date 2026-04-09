from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.models.market import ExchangeName


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "ArbRadar API"
    app_env: str = "development"
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"])

    default_poll_interval_seconds: int = 12
    default_history_limit: int = 48
    min_confidence_score: float = 0.35
    min_combined_oi_usd: float = 500_000
    max_price_dislocation_percent: float = 0.75

    binance_enabled: bool = True
    delta_enabled: bool = True
    coindcx_enabled: bool = False
    coinswitch_enabled: bool = False
    coinswitch_api_key: str | None = None
    coinswitch_secret_key: str | None = None
    coinswitch_exchange: str = "EXCHANGE_2"
    telegram_enabled: bool = False
    telegram_bot_token: str | None = None
    telegram_chat_id: str | None = None
    telegram_chat_ids: list[str] = Field(default_factory=list)
    telegram_min_spread_percent: float = 0.5
    telegram_min_confidence_score: float = 0.55
    telegram_min_combined_oi_usd: float = 1_000_000
    telegram_max_staleness_seconds: int = 45
    telegram_top_n: int = 5
    telegram_cooldown_minutes: int = 30
    telegram_poll_interval_seconds: int = 8
    retention_prune_interval_minutes: int = 30
    funding_snapshot_retention_hours: int = 72
    opportunity_history_retention_days: int = 30
    telegram_alert_state_retention_days: int = 90
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
        return exchanges


@lru_cache
def get_settings() -> Settings:
    return Settings()
