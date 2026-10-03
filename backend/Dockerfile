FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# SQLite (journal, history, encrypted keys) lives on a mounted volume so it survives redeploys.
VOLUME ["/app/data"]
EXPOSE 8000

# Live-update streams stay open; cap the shutdown wait so restarts never hang.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-graceful-shutdown", "5"]
