# OpenResponses Proxy Server

A generic, deployable proxy that turns any OpenResponses-compatible API into an AG-UI endpoint.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST /` | Generic | Config via `forwarded_props` |
| `POST /configs/{name}` | Named config | Uses `configs/{name}.json` |
| `GET /configs` | List configs | Returns available config names |
| `GET /health` | Health check | Returns `{"status": "ok"}` |

## Configuration

Place JSON config files in the `configs/` directory. Environment variables are resolved using `${VAR}` syntax, with optional defaults via `${VAR:-default}`.

Example `configs/openai-prod.json`:
```json
{
  "provider": "openai",
  "base_url": "https://api.openai.com/v1",
  "api_key": "${OPENAI_API_KEY}",
  "default_model": "gpt-4o"
}
```

Override the config directory with the `OPENRESPONSES_CONFIG_DIR` environment variable.

Set `OPENRESPONSES_RESTRICT_CONFIGS=true` to disable the generic `POST /` endpoint and require a named config for every request. When enabled, caller-supplied overrides in `forwarded_props` can only fill fields that the named config leaves unset — they cannot override values the config already provides.

## Local Development

```bash
cd python/
pip install -e .
cd server/
OPENAI_API_KEY=sk-... python -m server
```

## Docker

The default `Dockerfile` installs `ag_ui_openresponses` from PyPI. Build from the `server/` directory:

```bash
cd python/server/
docker build -t openresponses-proxy .
docker run -e OPENAI_API_KEY=sk-... -p 8080:8080 openresponses-proxy
```

To build from the local monorepo source instead, use `Dockerfile.local` from the `integrations/openresponses/` directory:

```bash
docker build -f python/server/Dockerfile.local -t openresponses-proxy .
docker run -e OPENAI_API_KEY=sk-... -p 8080:8080 openresponses-proxy
```

## Deploy to Railway

1. Connect your repo to Railway and set the root directory to `integrations/openresponses/python/server`
2. Set `OPENAI_API_KEY` (or other provider keys) as environment variables
3. Railway auto-detects `railway.json`

## Deploy to Render

1. Connect your repo to Render and set the root directory to `integrations/openresponses/python/server`
2. Render auto-detects `render.yaml`
3. Set environment variables in the Render dashboard

## Deploy to Fly.io

```bash
cd python/server/
fly launch --config fly.toml
fly secrets set OPENAI_API_KEY=sk-...
fly deploy
```
