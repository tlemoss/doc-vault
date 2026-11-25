# Stage 1: Build client & server
FROM node:24-slim AS builder

WORKDIR /app

COPY server/package.json server/package-lock.json* ./server/
COPY client/package.json client/package-lock.json* ./client/

RUN npm --prefix server ci --no-audit --no-fund 2>/dev/null || npm --prefix server install --no-audit --no-fund
RUN npm --prefix client ci --no-audit --no-fund 2>/dev/null || npm --prefix client install --no-audit --no-fund

COPY server ./server
COPY client ./client

RUN npm --prefix client run build && npm --prefix server run build

# Stage 2: Minimal runtime image
FROM node:24-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/data
ENV CLIENT_DIST_DIR=/app/client/dist

COPY server/package.json server/package-lock.json* ./server/
RUN npm --prefix server ci --omit=dev --no-audit --no-fund 2>/dev/null || npm --prefix server install --omit=dev --no-audit --no-fund

COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/dist/index.js"]
