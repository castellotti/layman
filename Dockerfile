FROM node:20-slim AS build
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/opencode-plugin/package.json packages/opencode-plugin/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build
RUN pnpm build

FROM node:20-slim
WORKDIR /app

# Copy built artifacts
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/web-dist ./web-dist
COPY --from=build /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/opencode-plugin ./packages/opencode-plugin

# Create a simple entry point
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

EXPOSE 8090

CMD ["node", "packages/server/dist/index.js", "start", "--host", "0.0.0.0", "--no-open"]
