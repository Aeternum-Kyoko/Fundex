# Build the site, then serve it with Caddy (HTTPS, gzip, SPA fallback, /api proxied to the backend).
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Same-origin API: the browser calls https://your-domain/api/...
ENV VITE_API_URL=/api
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /src/dist /srv
COPY deploy-caddyfile /etc/caddy/Caddyfile
