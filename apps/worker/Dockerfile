FROM node:26-alpine
WORKDIR /app
RUN apk add --no-cache chromium \
 && npm install -g pnpm@10.0.0
ENV PATROL_CHROMIUM_PATH=/usr/bin/chromium
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/matching/package.json packages/matching/package.json
RUN pnpm install --frozen-lockfile
COPY packages/matching packages/matching
COPY apps/worker apps/worker
RUN pnpm --filter @patrol/matching build && pnpm --filter @patrol/worker build
CMD ["node", "apps/worker/dist/index.js"]
