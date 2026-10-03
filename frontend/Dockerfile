# Build the site, then serve it with Caddy (HTTPS, gzip, SPA fallback, /api proxied to the backend).
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Same-origin API: the browser calls https://your-domain/api/...
ENV VITE_API_URL=/api
# Optional client-side login screen. It only hides the UI: the values end up in the JS bundle,
# so it is not real security. The admin API is protected separately by ADMIN_TOKEN.
ARG VITE_AUTH_USERNAME=""
ARG VITE_AUTH_PASSWORD=""
ENV VITE_AUTH_USERNAME=$VITE_AUTH_USERNAME VITE_AUTH_PASSWORD=$VITE_AUTH_PASSWORD
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /src/dist /srv
COPY deploy-caddyfile /etc/caddy/Caddyfile
