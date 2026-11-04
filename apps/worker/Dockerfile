FROM node:26-alpine
WORKDIR /app
RUN npm install -g pnpm@10.0.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY apps/worker apps/worker
RUN pnpm --filter @patrol/worker build
CMD ["node", "apps/worker/dist/index.js"]
