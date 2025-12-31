# CopilotKit + Claude Agent SDK Integration Demo

This example demonstrates how to integrate Claude Agent SDK into CopilotKit using AG-UI Protocol.

## Architecture Diagram

```
┌─────────────────────────────────────┐
│  CopilotKit Frontend (React/Next.js) │
│  - CopilotChat UI                    │
│  - Frontend Tools                    │
└──────────────┬──────────────────────┘
               │ HTTP/SSE
               ↓
┌─────────────────────────────────────┐
│  CopilotKit Runtime (Next.js API)    │
│  - HttpAgent (@ag-ui/client)         │
│  - CopilotRuntime                    │
└──────────────┬──────────────────────┘
               │ AG-UI Protocol
               ↓
┌─────────────────────────────────────┐
│  Claude Agent SDK Server (FastAPI)   │
│  - AG-UI Protocol Endpoint           │
│  - ClaudeAgent                       │
└──────────────┬──────────────────────┘
               │
               ↓
┌─────────────────────────────────────┐
│  Claude Agent SDK (Python)           │
│  - ClaudeSDKClient                   │
│  - Multi-turn Conversations          │
└─────────────────────────────────────┘
```

## Quick Start

### 1. Start Claude Agent SDK Server

In one terminal:

```bash
cd ../../python/examples/server
python fastapi_server.py
```

The server will run at `http://localhost:8000/chat`.

### 2. Install and Start CopilotKit Frontend

In another terminal:

```bash
cd integrations/claude-agent-sdk/typescript/examples/copilotkit
npm install
npm run dev
```

The frontend will run at `http://localhost:3000`.

### 3. Open Browser

Visit `http://localhost:3000` to see the CopilotKit chat interface.

## Features

- ✅ **Persistent Conversations**: Uses `ClaudeSDKClient` to maintain conversation history
- ✅ **Tool Support**: Claude can call frontend tools
- ✅ **Streaming Responses**: Real-time streaming via Server-Sent Events
- ✅ **Session Management**: Persistent sessions across multiple requests
- ✅ **Full Features**: Supports interrupts, hooks, custom tools (when using `ClaudeSDKClient`)

## Directory Structure

```
copilotkit/
├── src/
│   └── app/
│       ├── api/
│       │   └── copilotkit/
│       │       └── route.ts        # CopilotKit runtime endpoint
│       ├── layout.tsx              # Next.js layout
│       ├── page.tsx                # Frontend chat interface
│       └── globals.css             # Global styles
├── package.json                    # Dependencies configuration
├── tsconfig.json                   # TypeScript configuration
├── next.config.js                  # Next.js configuration
├── tailwind.config.js              # Tailwind CSS configuration
├── postcss.config.js               # PostCSS configuration
└── README.md                       # Detailed documentation
```

## How It Works

### 1. Frontend (React + CopilotKit)

`src/app/page.tsx` uses CopilotKit React components:
- `CopilotKit`: Wraps the app and connects to runtime
- `CopilotChat`: Provides chat UI
- `useFrontendTool`: Defines frontend tools that Claude can call

### 2. API Route (Next.js)

`src/app/api/copilotkit/route.ts`:
- Creates `HttpAgent` (from `@ag-ui/client`) pointing to Claude Agent SDK server
- Wraps it in `CopilotRuntime`
- Exposes POST endpoint that CopilotKit calls

### 3. Backend (Claude Agent SDK)

Claude Agent SDK server (`../../python/examples/server/fastapi_server.py`):
- Handles AG-UI Protocol requests
- Converts them to Claude Agent SDK calls
- Returns AG-UI Protocol events
- Supports CORS for frontend integration

## Environment Variables

- `CLAUDE_AGENT_URL`: URL of Claude Agent SDK server (default: `http://localhost:8000/chat`)

## Troubleshooting

1. **Connection Error**: Ensure Claude Agent SDK server is running on the correct port
2. **CORS Issues**: FastAPI server includes CORS middleware. Edit `fastapi_server.py` if you need to add more origins
3. **Agent Not Found**: Check if the agent ID (`agentic_chat`) in the frontend matches the one in the API route

## References

- [CopilotKit Documentation](https://docs.copilotkit.ai/adk/quickstart?path=exiting-agent)
- [AG-UI Protocol Documentation](https://ag-ui-protocol.github.io/ag-ui/)
- [Claude Agent SDK Documentation](https://docs.claude.com/api/agent-sdk/python)
