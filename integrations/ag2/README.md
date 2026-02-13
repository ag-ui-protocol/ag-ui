# AG2 Integration

[AG2](https://ag2.ai/) (formerly AutoGen) integration for the AG-UI protocol. Exposes AG2 agents via [AGUIStream](https://docs.ag2.ai/latest/docs/user-guide/ag-ui/) for use with the Dojo and other AG-UI frontends.

## Structure

- **python/examples** – FastAPI server with AG2 `ConversableAgent` + `AGUIStream`, one agentic chat endpoint
- **typescript** – `@ag-ui/ag2` client package (`Ag2Agent` extending `HttpAgent`)

## Local development with the Dojo

### 1. Install and build (from repo root)

```bash
pnpm install
pnpm build --filter=demo-viewer
```

### 2. Run the AG2 agent (terminal 1)

```bash
cd integrations/ag2/python/examples
uv sync
export OPENAI_API_KEY=your-key
uv run dev
```

Server runs at **http://localhost:8018**.

### 3. Run the Dojo (terminal 2)

```bash
# From repo root – picks up AG2 and other integration changes
export AG2_URL=http://localhost:8018
pnpm dev
```

Dojo runs at **http://localhost:3000**. Open **AG2** in the sidebar and use the **Agentic Chat** feature.

### Optional: run only Dojo + AG2 via scripts

```bash
cd apps/dojo
./scripts/prep-dojo-everything.js --only ag2,dojo-dev
# In another terminal, start the AG2 server (see step 2), then:
./scripts/run-dojo-everything.js --only ag2,dojo-dev
```

Dojo will be at **http://localhost:9999** with `AG2_URL` set to http://localhost:8018.

## References

- [AG2 AG-UI documentation](https://docs.ag2.ai/latest/docs/user-guide/ag-ui/)
- [AG-UI Protocol](https://docs.ag-ui.com/introduction)
