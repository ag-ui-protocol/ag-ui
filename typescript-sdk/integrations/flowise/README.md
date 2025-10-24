# @ag-ui/flowise

Flowise integration for AG-UI protocol.

## Installation

```bash
npm install @ag-ui/flowise
```

## Usage

```typescript
import { FlowiseAgent } from '@ag-ui/flowise';

const agent = new FlowiseAgent({
  apiUrl: 'http://localhost:3000/api/v1/prediction/{flowId}',
  flowId: 'your-flow-id',
  apiKey: 'your-api-key', // Optional
});

// Use the agent with AG-UI components
```

## API Reference

### FlowiseAgentConfig

| Property | Type | Description |
|---------|------|-------------|
| `apiUrl` | string | The Flowise API endpoint URL |
| `flowId` | string | The Flowise flow ID |
| `apiKey` | string (optional) | API key for authentication |
| `headers` | Record<string, string> (optional) | Additional headers to send with requests |

## License

MIT