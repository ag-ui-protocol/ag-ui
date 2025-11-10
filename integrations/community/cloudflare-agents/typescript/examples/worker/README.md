# Cloudflare Agents Example Server

Minimal AG-UI-compliant Cloudflare Worker using the Agents SDK.

## Quick Start

```bash
pnpm install
pnpm dev       # Run locally at ws://127.0.0.1:8787
pnpm deploy    # Deploy to Cloudflare
```

## Test

Open `client.html` in your browser and connect to the WebSocket endpoint.

## AG-UI Event Sequence

This example emits the standard AG-UI event flow:

```
RUN_STARTED → TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT → TEXT_MESSAGE_END → RUN_FINISHED
```

## Files

- `src/worker.ts` - Cloudflare Worker entry point
- `src/agent.ts` - Minimal AG-UI agent implementation
- `wrangler.jsonc` - Cloudflare configuration
- `client.html` - Test client
