# Strands server example

This folder shows how to wrap a Strands SDK agent with the AG-UI server adapter and expose it over HTTP.

```bash
pnpm install
pnpm dev
```

The script starts an example server on `http://localhost:8000/runs` that streams AG-UI events with state synchronization helpers.
