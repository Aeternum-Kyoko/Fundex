# ArbRadar - Binance vs Delta Funding Monitor

ArbRadar is a monitor-first funding spread dashboard for `Binance`, `Delta Exchange India`, and `CoinDCX`. It tracks live funding differences, ranks opportunities, stores short-term history, and sends Telegram alerts when high-quality spreads enter or exit the qualified alert set.

## Current Phase

We are in `Phase 4 - Monitor Operations`.

This build is for monitoring and alerting only:

- live Binance and Delta public market-data ingestion
- live CoinDCX public market-data ingestion
- funding-spread ranking
- exchange health and runtime metrics
- history persistence in SQLite
- dark dashboard with watchlists, overview modal, funding leaders, funding settlement board, trends, mobile mode, and CSV export
- Telegram bot commands, stateful alerting, and scheduled summaries

## Stack

- Backend: `FastAPI`, `httpx`, `pydantic-settings`, `SQLite`
- Frontend: `React`, `TypeScript`, `Vite`
- Deployment target:
  - backend on `Railway`
  - frontend on `Vercel`

## Project Structure

```text
backend/
  app/
    adapters/
    api/
    core/
    models/
    services/
  tests/
frontend/
  src/
    components/
    hooks/
    lib/
```

## Local Run

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Backend runs at [http://127.0.0.1:8000](http://127.0.0.1:8000).

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at [http://127.0.0.1:5173](http://127.0.0.1:5173).

## Tests

Run backend tests:

```bash
cd backend
python -m unittest discover -s tests -v
```

Optional backend compile check:

```bash
cd ..
@'
import pathlib, py_compile
for path in pathlib.Path("backend/app").rglob("*.py"):
    py_compile.compile(str(path), doraise=True)
'@ | python -
```

Build frontend:

```bash
cd frontend
npm run build
```

## Environment Variables

### Backend

Copy [backend/.env.example](C:/Users/thewa/Desktop/Amitabh/backend/.env.example) to `backend/.env`.

Core settings:

- `APP_NAME`
- `APP_ENV`
- `CORS_ORIGINS`
- `DATABASE_PATH`
- `DEFAULT_POLL_INTERVAL_SECONDS`
- `DEFAULT_HISTORY_LIMIT`
- `MIN_CONFIDENCE_SCORE`
- `MIN_COMBINED_OI_USD`
- `MAX_PRICE_DISLOCATION_PERCENT`

Telegram settings:

- `TELEGRAM_ENABLED`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_CHAT_IDS`
- `TELEGRAM_MIN_SPREAD_PERCENT`
- `TELEGRAM_MIN_CONFIDENCE_SCORE`
- `TELEGRAM_MIN_COMBINED_OI_USD`
- `TELEGRAM_MAX_STALENESS_SECONDS`
- `TELEGRAM_TOP_N`
- `TELEGRAM_COOLDOWN_MINUTES`
- `TELEGRAM_POLL_INTERVAL_SECONDS`
- `TELEGRAM_DAILY_SUMMARY_ENABLED`
- `TELEGRAM_DAILY_SUMMARY_TIMEZONE`
- `TELEGRAM_DAILY_SUMMARY_TOP_N`
- `TELEGRAM_MORNING_SUMMARY_ENABLED`
- `TELEGRAM_MORNING_SUMMARY_HOUR`
- `TELEGRAM_MORNING_SUMMARY_MINUTE`
- `TELEGRAM_EVENING_SUMMARY_ENABLED`
- `TELEGRAM_EVENING_SUMMARY_HOUR`
- `TELEGRAM_EVENING_SUMMARY_MINUTE`
- `TELEGRAM_NIGHT_SUMMARY_ENABLED`
- `TELEGRAM_NIGHT_SUMMARY_HOUR`
- `TELEGRAM_NIGHT_SUMMARY_MINUTE`

Retention settings:

- `RETENTION_PRUNE_INTERVAL_MINUTES`
- `FUNDING_SNAPSHOT_RETENTION_HOURS`
- `OPPORTUNITY_HISTORY_RETENTION_DAYS`
- `TELEGRAM_ALERT_STATE_RETENTION_DAYS`

### Frontend

Create `frontend/.env.local` for local use or set the same variable in Vercel:

```bash
VITE_API_URL=http://127.0.0.1:8000/api
```

For Vercel production, `VITE_API_URL` should point to your Railway backend, for example:

```bash
VITE_API_URL=https://your-backend.up.railway.app/api
```

## Runtime Metrics

Useful API checks:

- `GET /api/health`
- `GET /api/system/metrics`
- `GET /api/exchanges/status`
- `GET /api/arbitrage-opportunities`
- `GET /api/exchanges/funding-leaders`
- `GET /api/exchanges/funding-settlements`
- `GET /api/exchanges/funding-trends`
- `GET /api/opportunities/{canonical_symbol}/history`
- `GET /api/telegram/status`
- `GET /api/telegram/preview`
- `GET /api/telegram/daily-summary-preview`
- `POST /api/telegram/send-daily-summary`

`GET /api/system/metrics` returns:

- adapter poll counts, failures, durations, and latest snapshot counts
- retention run stats and deleted-row counts
- Telegram bot polling and send counters

## SQLite Retention

The backend now prunes old SQLite rows automatically.

Default retention:

- funding snapshots: `72 hours`
- opportunity history: `30 days`
- inactive Telegram alert state: `90 days`
- prune interval: every `30 minutes`

This keeps the local database from growing forever while preserving enough recent history for the dashboard and alert engine.

## Telegram Bot

The bot supports:

- `/start`
- `/help`
- `/coin BTC`
- `/toppositive`
- `/topnegative`
- `/binance`
- `/delta`
- `/watch BTC`
- `/unwatch BTC`
- `/watchlist`
- `/alerts`
- `/alerts on`
- `/alerts off`

Automatic alerts are stateful and quality-filtered:

- minimum spread
- minimum confidence
- minimum combined OI
- stale-data protection
- duplicate suppression per symbol
- entered / exited alert updates

Scheduled summaries are supported too:

- `Morning Summary`
- `Evening Summary`
- `Night Summary`

Default schedule in `Asia/Kolkata`:

- morning: `09:00`
- evening: `18:00`
- night: `22:00`

## Railway Backend Deployment

### Recommended production layout

Deploy only the `backend` directory to Railway.

Preferred Railway setup:

- set the service root directory to:

```text
backend
```

- use this start command:

```bash
bash ./start.sh
```

Fallback setup if Railway still starts from repo root:

```bash
bash ./start.sh
```

This repo now includes a root-level [start.sh](C:/Users/thewa/Desktop/Amitabh/start.sh) that delegates into [backend/start.sh](C:/Users/thewa/Desktop/Amitabh/backend/start.sh), so the same command works from either location.

Why this works:

- the FastAPI API runs in the web process
- the Telegram bot poller is started inside FastAPI lifespan in [main.py](C:/Users/thewa/Desktop/Amitabh/backend/app/main.py)
- so Railway only needs one long-running process, not a second worker

Important deployment rule:

- keep the Railway backend at `1 replica`

Why:

- the Telegram bot poller is in-process, so multiple replicas would poll the same bot more than once
- SQLite on a Railway volume is appropriate for a single app instance, not horizontal scaling
- if more than one poller is active, Telegram will usually return `409 Conflict` from `getUpdates`

### SQLite on Railway

For Railway, SQLite should live on a `Railway Volume`, not the ephemeral container filesystem.

Recommended setup:

1. Create a Railway volume
2. Mount it to `/app/data`
3. Set:

```bash
DATABASE_PATH=/app/data/arbradar.db
```

That matches Railway’s current volume guidance that relative app data should be mounted under `/app/...` when you want it persisted.

If you do not mount a volume, your SQLite data can disappear on redeploy or reschedule.

### Railway production env

At minimum set:

```bash
APP_ENV=production
DATABASE_PATH=/app/data/arbradar.db
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_IDS=["...","..."]
TELEGRAM_DAILY_SUMMARY_ENABLED=true
TELEGRAM_DAILY_SUMMARY_TIMEZONE=Asia/Kolkata
TELEGRAM_DAILY_SUMMARY_TOP_N=5
TELEGRAM_MORNING_SUMMARY_ENABLED=true
TELEGRAM_MORNING_SUMMARY_HOUR=9
TELEGRAM_MORNING_SUMMARY_MINUTE=0
TELEGRAM_EVENING_SUMMARY_ENABLED=true
TELEGRAM_EVENING_SUMMARY_HOUR=18
TELEGRAM_EVENING_SUMMARY_MINUTE=0
TELEGRAM_NIGHT_SUMMARY_ENABLED=true
TELEGRAM_NIGHT_SUMMARY_HOUR=22
TELEGRAM_NIGHT_SUMMARY_MINUTE=0
```

Also set your CORS to your Vercel domain, for example:

```bash
CORS_ORIGINS=["https://your-frontend.vercel.app"]
```

Production verification checklist:

1. Open `GET /api/telegram/status`
2. Confirm `summary_schedules` includes `morning`, `evening`, and `night`
3. Confirm `update_errors = 0`
4. Keep Railway at `1 replica`

Current production check on `2026-04-09`:

- `GET /api/health` returned `200`
- `GET /api/telegram/status` returned `200`
- production `summary_schedules` already shows `morning`, `evening`, and `night`
- production `update_errors = 0`

That means the production bot poller currently looks healthy, and there is no active sign of duplicate Telegram polling on Railway.

## Vercel Frontend Deployment

Deploy only the `frontend` directory to Vercel.

Set the Vercel project root directory to:

```text
frontend
```

Vercel handles Vite builds natively. The key frontend production variable is:

```bash
VITE_API_URL=https://your-backend.up.railway.app/api
```

After changing Vercel environment variables, create a new deployment so the built frontend picks them up.

## Final Smoke Test

Before or right after production deploy, verify:

- [http://127.0.0.1:8000/api/health](http://127.0.0.1:8000/api/health)
- [http://127.0.0.1:8000/api/system/metrics](http://127.0.0.1:8000/api/system/metrics)
- [http://127.0.0.1:8000/api/arbitrage-opportunities](http://127.0.0.1:8000/api/arbitrage-opportunities)
- [http://127.0.0.1:8000/api/telegram/status](http://127.0.0.1:8000/api/telegram/status)

For production, replace `127.0.0.1:8000` with your Railway domain.

## Exchange Notes

- `Binance`: public market data only, no API key needed for this monitor
- `Delta Exchange India`: public market data only, no API key needed for this monitor
- `CoinDCX`: public market data only, no API key needed for this monitor
- `CoinSwitch`: still excluded from the public monitor build because the futures feed needs signed access

## References

- [Railway start command docs](https://docs.railway.com/deployments/start-command)
- [Railway volumes guide](https://docs.railway.com/guides/volumes)
- [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
