FROM node:22-alpine AS builder

WORKDIR /build

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY src ./src
COPY tsconfig.json ./
COPY system/ ./system/
COPY web/ ./web/

RUN npm run build

FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

RUN apk add --no-cache su-exec

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

COPY --from=builder /build/dist ./dist
COPY system/ ./system/
COPY web/ ./web/

RUN cp system/alfred-cli.js /usr/local/bin/alfred-cli && \
    chmod +x /usr/local/bin/alfred-cli

RUN mkdir -p /workspace/{db,files,skills,config,logs,memory/{sessions,jobs,personality,vectors,snapshots}}

RUN chown -R node:node /app /workspace

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "const ws=require('ws');new ws('ws://127.0.0.1:18789').on('open',()=>process.exit(0)).on('error',()=>process.exit(1))"

CMD ["node", "/app/dist/index.js"]
