# Deploying Fundex for free

Fundex's backend must run **all the time** (exchange pollers, the Delta websocket, the trade scheduler and the Telegram bot) and keep a **disk** (SQLite holds the trade journal, history and encrypted keys). Its server must also be somewhere **Binance's futures API allows**: Binance answers HTTP 451 to US-hosted servers, even for public data.

| Option | Always on | Keeps data | Notes |
|---|---|---|---|
| **Oracle Cloud Always Free VM** (recommended) | yes | yes | Real Linux VM, free permanently. Pick an India region (Mumbai or Hyderabad) at sign-up. Card needed for verification only. |
| Koyeb free | yes | no | Disk resets on every redeploy, so the journal and saved keys are lost. Card required. Fine for a monitor-only copy. |
| Render free | no (sleeps after 15 min) | no | Unsuitable: a sleeping server misses trade windows and the bot goes quiet. |
| Google Cloud free VM | yes | yes | US regions only, so Binance futures is blocked. |

The website can also go on Vercel or Cloudflare Pages for free, but the simplest setup below serves the site and the API from the same server and domain.

## 1. Create the server (Oracle Cloud)

1. Sign up at cloud.oracle.com and choose **India South (Hyderabad)** or **India West (Mumbai)** as the home region.
2. Create a compute instance: image **Ubuntu 24.04**, shape **VM.Standard.A1.Flex** (Ampere, always-free eligible) with 1–2 OCPU and 6–12 GB memory. Add your SSH key.
3. In the instance's VCN → Security List, add ingress rules for TCP **80** and **443** from `0.0.0.0/0`.
4. SSH in and open the same ports in the VM firewall:
   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

## 2. Get a domain name (free option)

HTTPS needs a hostname. A free subdomain from duckdns.org works: create `yourname.duckdns.org` and point it at the VM's public IP.

## 3. Install Docker and the app

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/Aeternum-Kyoko/Fundex.git
cd Fundex
cp backend/.env.example backend/.env
nano backend/.env
```

In `backend/.env`, set at least:

- `ADMIN_TOKEN` and `CREDENTIALS_ENCRYPTION_KEY` (generate them with the commands in the file comments; keep them private).
- `TELEGRAM_ENABLED=true`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` if you want the bot.
- Exchange switches (`COINDCX_ENABLED`, `WAZIRX_ENABLED`, …).

## 4. Start it

```bash
SITE_ADDRESS=yourname.duckdns.org docker compose -f deploy/docker-compose.yml up -d --build
```

Caddy gets an HTTPS certificate automatically. Open `https://yourname.duckdns.org`.

Useful commands:

```bash
docker compose -f deploy/docker-compose.yml logs -f backend   # live logs
docker compose -f deploy/docker-compose.yml restart backend   # restart
git pull && SITE_ADDRESS=yourname.duckdns.org docker compose -f deploy/docker-compose.yml up -d --build   # update
```

The trade journal, history and keys live in the `fundex-data` Docker volume and survive updates. Back it up with:

```bash
docker run --rm -v deploy_fundex-data:/data -v "$PWD":/backup alpine tar czf /backup/fundex-data.tgz -C /data .
```

## 5. After deploying, check

- The top bar shows every exchange with a recent update, and "Live".
- `https://yourname.duckdns.org/api/exchanges/status` lists no errors (a Binance 451 error means the server region is blocked).
- Send `/next` to your bot.
- Optional login screen: add `VITE_AUTH_USERNAME=... VITE_AUTH_PASSWORD=...` before the `docker compose` command. It only hides the UI (the values are visible in the downloaded JavaScript), so it is not real security; the admin API is protected separately by `ADMIN_TOKEN`.
