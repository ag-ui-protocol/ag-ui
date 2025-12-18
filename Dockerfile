FROM node:20-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN npm install -g pnpm
RUN npm install -g turbo

COPY . /app/ag-ui
WORKDIR /app/ag-ui

RUN pnpm install --frozen-lockfile
RUN pnpm run build

WORKDIR /app/ag-ui/apps/dojo

EXPOSE 3000
CMD ["pnpm", "run", "start"]