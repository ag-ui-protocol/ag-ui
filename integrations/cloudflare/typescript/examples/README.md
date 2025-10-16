# Cloudflare AG-UI Examples Server

This server provides AG-UI endpoints using Cloudflare Workers AI models, demonstrating all major protocol features.

## Quick Start

1. Copy `.env.example` to `.env` and fill in your Cloudflare credentials:

   ```bash
   cp .env.example .env
   ```

2. Get your Cloudflare credentials:
   - **Account ID**: Found in Cloudflare dashboard
   - **API Token**: Create one at <https://dash.cloudflare.com/profile/api-tokens>
     - Use "Workers AI" template or create custom with "Workers AI:Read" permission

3. Install dependencies:

   ```bash
   pnpm install
   ```

4. Run the server:

   ```bash
   pnpm start
   ```

5. Server runs on `http://localhost:4114` with 6 available agents

## Available Agents

### Core Demos

#### `POST /agentic_chat`

Basic conversational chat with streaming responses.

- **Model**: Llama 3.1 8B Instruct
- **Features**: Text streaming, tool calling support
- **Use Case**: Standard chat interface, Q&A bot

**Example Request**:

```bash
curl -X POST http://localhost:4114/agentic_chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"id": "1", "role": "user", "content": "Hello! Tell me about dogs."}
    ]
  }'
```

#### `POST /tool_based_generative_ui`

Demonstrates frontend-provided tools with generative UI rendering.

- **Model**: Llama 3.1 70B Instruct
- **Features**: Tool calling, custom UI components
- **Use Case**: Haiku generation, custom component rendering

**Try It**: Ask "Write me a haiku about coding" to see the `generate_haiku` tool in action.

#### `POST /agentic_generative_ui`

Progressive state updates showing task execution steps.

- **Model**: Llama 3.1 8B Instruct
- **Features**: STATE_SNAPSHOT events, step-by-step progress
- **Use Case**: Multi-step task planning, progress tracking

**Try It**: Ask "How do I make a sandwich?" to see progressive task breakdown.

### Advanced Demos

#### `POST /human_in_the_loop`

Interactive task planning requiring user confirmation before proceeding.

- **Model**: Llama 3.1 8B Instruct
- **Features**: User approval workflows, task step selection
- **Use Case**: Critical operations requiring approval, guided workflows

**Try It**: Ask "Plan a project for building a website" to get an interactive task list.

#### `POST /shared_state`

Persistent state management across multiple conversation turns.

- **Model**: Llama 3.1 8B Instruct
- **Features**: STATE_SNAPSHOT/DELTA events, persistent to-do list
- **Use Case**: Shopping lists, task management, memory across sessions

**Try It**: "Add milk to my list", then "What's on my list?" to see state persistence.

#### `POST /backend_tool_rendering`

Server-generated UI components sent to the frontend for rendering.

- **Model**: Llama 3.1 8B Instruct
- **Features**: Backend-rendered components, TOOL_RESULT with render prop
- **Use Case**: Weather widgets, charts, rich data displays

**Try It**: Ask about weather or stock prices to see rich UI components.

## Testing with AG-UI Dojo

The recommended way to test these agents is through the AG-UI Dojo:

```bash
# Terminal 1: Run this examples server
cd integrations/cloudflare/typescript/examples
pnpm start

# Terminal 2: Run the Dojo
cd apps/dojo
pnpm dev

# Open browser: http://localhost:3000
# Navigate to Cloudflare integration
```

## Environment Variables

- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID (required)
- `CLOUDFLARE_API_TOKEN` - Your Cloudflare API token (required)
- `PORT` - Server port (default: 4114)
- `HOST` - Server host (default: 0.0.0.0)

## Architecture

Each agent follows the same pattern:

```text
src/agents/
├── agentic_chat/
│   ├── agent.ts       # Agent implementation (extends CloudflareAgent)
│   └── index.ts       # Express route handler
├── human_in_the_loop/
│   ├── agent.ts
│   └── index.ts
└── ...
```

All agents:

1. Extend `CloudflareAgent` from `@ag-ui/cloudflare`
2. Implement proper AG-UI protocol event emission
3. Use SSE (Server-Sent Events) for streaming
4. Handle tool calls and state management

## Adding New Agents

1. Create agent directory: `src/agents/my_agent/`
2. Implement agent class extending `CloudflareAgent`
3. Create Express handler in `index.ts`
4. Register in `src/index.ts` routes
5. Add to `cloudflare.json` configuration
6. Restart server

See existing agents for reference implementation patterns.

## Health Check

```bash
curl http://localhost:4114/health
```

Returns list of available agents and server status.

## Troubleshooting

**Issue**: `Missing required environment variables`

- Solution: Ensure `.env` file exists with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`

**Issue**: `401 Unauthorized`

- Solution: Verify API token has "Workers AI:Read" permission

**Issue**: Model not found

- Solution: Check model name matches Cloudflare Workers AI available models

## Learn More

- [Cloudflare Workers AI Documentation](https://developers.cloudflare.com/workers-ai/)
- [AG-UI Protocol Specification](https://docs.ag-ui.com/)
- [Available Cloudflare AI Models](https://developers.cloudflare.com/workers-ai/models/)
