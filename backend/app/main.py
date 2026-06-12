from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.config import get_settings
from app.services.history_store import HistoryStore
from app.services.market_engine import MarketEngine
from app.services.market_store import MarketStore
from app.services.trade_manager import TradeManager

settings = get_settings()
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    store = MarketStore()
    history_store = HistoryStore(settings.database_file)
    engine = MarketEngine(settings, store, history_store)
    trade_manager = TradeManager(settings, store)
    app.state.market_store = store
    app.state.history_store = history_store
    app.state.market_engine = engine
    app.state.telegram_notifier = engine.telegram_notifier
    app.state.trade_manager = trade_manager
    app.state.settings = settings
    await engine.start()
    try:
        yield
    finally:
        await engine.stop()
        await trade_manager.stop()


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router, prefix="/api")
