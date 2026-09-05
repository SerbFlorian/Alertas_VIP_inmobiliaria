# ============================================
# Alertas VIP Telegram — Dockerfile
# Multi-stage · non-root (uid 1001) · Prisma engines Alpine
# ============================================

FROM node:22-alpine AS builder

WORKDIR /app

# Engines CLI + client para musl/OpenSSL3 (Alpine)
ENV PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma/ ./prisma/
COPY src/ ./src/
RUN npx prisma generate
RUN npm run build

# --- Prod deps (+ mismos engines) ---
FROM node:22-alpine AS deps
WORKDIR /app
ENV PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x

COPY package.json package-lock.json ./
COPY prisma/ ./prisma/
RUN npm ci --omit=dev \
  && npx prisma generate \
  && echo "── Prisma engines present ──" \
  && find node_modules -name 'schema-engine*' -o -name 'libquery-engine*' 2>/dev/null | head -40

FROM node:22-alpine AS production

WORKDIR /app

RUN apk add --no-cache postgresql-client openssl wget \
  && addgroup -g 1001 -S nodejs \
  && adduser -S nodejs -u 1001 -G nodejs \
  && mkdir -p /app/data /app/logs \
  && chown -R nodejs:nodejs /app

COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --chown=nodejs:nodejs prisma/ ./prisma/
COPY --chown=nodejs:nodejs package.json ./
COPY --chown=nodejs:nodejs docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
  && mkdir -p /app/node_modules/prisma/engines /tmp \
  && chown -R nodejs:nodejs /app /tmp

ENV NODE_ENV=production
ENV PORT=3001
ENV TZ=Europe/Madrid
ENV DATA_DIR=/app/data
ENV HOME=/tmp
ENV TMPDIR=/tmp
ENV PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x

EXPOSE 3001

USER nodejs

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
