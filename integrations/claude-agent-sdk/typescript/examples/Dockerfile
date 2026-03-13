FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@10.13.1 --activate

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile

# Build required workspace packages in dependency order
RUN pnpm --filter @ag-ui/proto build && \
    pnpm --filter @ag-ui/core build && \
    pnpm --filter @ag-ui/client build && \
    pnpm --filter @ag-ui/encoder build && \
    pnpm --filter @ag-ui/claude-agent-sdk build

WORKDIR /app/integrations/claude-agent-sdk/typescript

CMD ["npx", "tsx", "examples/server.ts"]
