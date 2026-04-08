# ArbRadar - Funding Rate Arbitrage Dashboard

ArbRadar is a real-time funding rate arbitrage dashboard inspired by Coinglass and focused on exchange coverage that includes Indian venues.

## Current Phase

We are in `Phase 4 - Monitor Operations`.

This build is focused on live market monitoring only:

- Live funding and mark-price ingestion
- Arbitrage ranking engine
- Exchange health monitoring
- Frontend dashboard
- Watchlists, alerts, countdowns, and export workflows

## Monitoring Scope

Implemented now:

- `Binance` live backend adapter
- `Delta Exchange India` live backend adapter
- Opportunity ranking with fee, slippage, liquidity, and confidence filtering
- SQLite persistence for snapshots and opportunity history
- Spread history endpoint and frontend overview modal
- Exchange health monitoring
- Watchlist management with local persistence
- Alert thresholds, browser notifications, and recent alert log
- CSV export for visible rows and watchlist rows

## Project Structure

```text
backend/
  app/
    adapters/
    api/
    core/
    models/
    services/
frontend/
  src/
    components/
    hooks/
    lib/
```

## Run The Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Backend runs at:

`http://127.0.0.1:8000`

## Run The Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at:

`http://127.0.0.1:5173`

## API Endpoints

- `GET /api/health`
- `GET /api/exchanges/status`
- `GET /api/arbitrage-opportunities`
- `GET /api/stream`
- `GET /api/opportunities/{canonical_symbol}/history`
- `GET /api/telegram/status`
- `GET /api/telegram/preview`
- `GET /api/telegram/discover-chats`
- `POST /api/telegram/test-send`
- `POST /api/telegram/demo-alert`

## Exchange Notes

- `Binance`: public funding and mark-price data is live
- `Delta Exchange India`: live ticker feed includes funding rate
- `CoinDCX` and `CoinSwitch` are intentionally trimmed out of this focused build

## API Keys

You do not need API keys for this monitoring build.

- `Binance`: public market data is enough
- `Delta`: public market data is enough

API keys are only needed later if you want live order execution or private account features.

## Telegram Alerts

You can enable Telegram alerts for the monitor without enabling trading.

The bot sends a formatted alert when:

- spread is at or above `0.5%`
- the opportunity is in the `top 5` by nearest funding expiry
- Binance and Delta are both present for that symbol

Each alert includes:

- symbol
- spread
- where to buy / long
- where to sell / short
- the two exchanges involved
- how soon funding expires

Set these values in `backend/.env`:

```bash
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TELEGRAM_CHAT_IDS=["chat_id_one","chat_id_two"]
TELEGRAM_MIN_SPREAD_PERCENT=0.5
TELEGRAM_TOP_N=5
TELEGRAM_COOLDOWN_MINUTES=30
```

Useful checks:

- `GET /api/telegram/status`
- `GET /api/telegram/preview`
- `GET /api/telegram/discover-chats`

How to finish Telegram setup:

1. Open your bot on Telegram and send `/start`
2. Call `GET /api/telegram/discover-chats`
3. Copy the returned `chat_id` values into `backend/.env` as `TELEGRAM_CHAT_IDS`
4. Restart the backend

You can verify delivery with:

- `POST /api/telegram/test-send`
- `POST /api/telegram/demo-alert`

Bot interaction:

- send `/start` or `/help`
- send `/coin BTC`
- or just send `BTC`, `ETH`, `SOL`, etc.
