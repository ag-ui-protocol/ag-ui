# AG-UI CLI Example

A command-line chat interface demonstrating the AG-UI client with a Mastra agent. This example shows how to build an interactive CLI application that streams agent responses and tool calls in real-time.

## Features

- Interactive chat loop with streaming responses
- Real-time tool call visualization (weather and browser tools)
- Message history persistence using LibSQL
- Built with `@ag-ui/client` and `@ag-ui/mastra`

## Prerequisites

- Node.js 22.13.0 or later
- OpenAI API key

## Setup

1. Install dependencies from the repository root:

   ```bash
   pnpm install
   ```

2. Set your OpenAI API key:
   ```bash
   export OPENAI_API_KEY=your_api_key_here
   ```

## Usage

Run the CLI:

```bash
pnpm start
```

Try these example prompts:

- "What's the weather in San Francisco?"
- "Browse https://example.com"

Press `Ctrl+D` to quit.

## How It Works

This example uses:

- **MastraAgent**: Wraps a Mastra agent with AG-UI protocol support
- **Event Handlers**: Streams text deltas, tool calls, and results to the console
- **Memory**: Persists conversation history in a local SQLite database
