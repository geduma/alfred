FROM node:22-alpine AS builder

WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY src ./src
COPY tsconfig.json ./
COPY system/ ./system/

RUN npm run build

FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /build/dist ./dist
COPY system/ ./system/

RUN cp system/alfred-cli.js /usr/local/bin/alfred-cli && \
    chmod +x /usr/local/bin/alfred-cli

RUN mkdir -p /workspace/{db,files,skills,config,logs,memory/{sessions,jobs,personality,vectors,snapshots}}

RUN chown -R node:node /app /workspace

USER node

EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "const ws=require('ws');new ws('ws://127.0.0.1:18789').on('open',()=>process.exit(0)).on('error',()=>process.exit(1))"

CMD ["node", "/app/dist/index.js"]
