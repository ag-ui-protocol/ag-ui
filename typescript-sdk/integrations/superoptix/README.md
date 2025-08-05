# SuperOptiX Integration

This package provides AG-UI integration for SuperOptiX agents.

## Features

- Agentic chat with SuperOptiX DSPy pipelines
- Tool-based generative UI
- Shared state management
- Predictive state updates

## Usage

```typescript
import { SuperOptiXAgent } from "@ag-ui/superoptix";

const agent = new SuperOptiXAgent({
  url: "http://localhost:8000"
});
```

## Development

```bash
pnpm install
pnpm build
```
