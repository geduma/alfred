FROM node:22-alpine AS builder

WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY src ./src
COPY tsconfig.json ./
COPY system/ ./system/

RUN npm run build

FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache chromium

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /build/dist ./dist
COPY system/ ./system/

RUN mkdir -p /workspace/{db,files,skills,config,logs,memory}

RUN chown -R node:node /app /workspace

USER node

EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "const ws=require('ws');new ws('ws://127.0.0.1:18789').on('open',()=>process.exit(0)).on('error',()=>process.exit(1))"

CMD ["node", "/app/dist/index.js"]
