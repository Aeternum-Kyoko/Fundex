FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# SQLite (journal, history, encrypted keys) lives in /app/data. Mount a volume there so it survives
# redeploys (a Railway Volume, or a named volume in docker compose). Railway rejects the VOLUME instruction.
RUN mkdir -p /app/data
EXPOSE 8000

# Hosts such as Railway inject $PORT; fall back to 8000 elsewhere. Live-update streams stay open,
# so the shutdown wait is capped and restarts never hang.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --timeout-graceful-shutdown 5"]
