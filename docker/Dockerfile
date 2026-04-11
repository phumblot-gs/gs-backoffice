FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/evt-client/package.json packages/evt-client/
COPY packages/jumpcloud-client/package.json packages/jumpcloud-client/
COPY apps/mcp-server/package.json apps/mcp-server/
COPY apps/evt-mock/package.json apps/evt-mock/
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm build

FROM base AS production
WORKDIR /app
COPY --from=build /app /app
RUN npm install --global paperclipai@latest
EXPOSE 3100
CMD ["paperclipai", "dev"]
