# LangGraph TypeScript Examples

This directory contains TypeScript versions of the LangGraph examples, providing the same functionality as the Python examples but implemented in TypeScript.

## How to run

First, make sure to create a new `.env` file from the `.env.example` and include the required keys:

```bash
cp .env.example .env
```

Then edit the `.env` file and add your API keys:
- `OPENAI_API_KEY`: Your OpenAI API key
- `TAVILY_API_KEY`: Your Tavily API key (if needed)

Install dependencies:

```bash
npm install
```

For TypeScript development, run:

```bash
npm run build
pnpx @langchain/langgraph-cli@latest dev
```

## Available Agents

This project includes TypeScript implementations of the following agents:

### 1. Agentic Chat (`agentic_chat`)
A simple agentic chat flow using LangGraph following the ReAct design pattern. Handles tool binding, system prompts, and model responses.

### 2. Agentic Generative UI (`agentic_generative_ui`)
Demonstrates agentic generative UI capabilities. Creates task steps and simulates their execution while streaming updates to the frontend.

### 3. Human in the Loop (`human_in_the_loop`)
Implements human-in-the-loop functionality where users can interact with and modify the agent's proposed steps before execution.

### 4. Predictive State Updates (`predictive_state_updates`)
Shows predictive state updates for document writing with streaming tool calls to the frontend.

### 5. Shared State (`shared_state`)
Demonstrates shared state management between the agent and CopilotKit, focusing on recipe creation and modification.

### 6. Tool-based Generative UI (`tool_based_generative_ui`)
Example of tool-based generative UI for haiku generation with image selection capabilities.

## Project Structure

```
integrations/langgraph/typescript/examples
├── src/
│   └── agents/
│       ├── agentic_chat/
│       │   ├── agent.ts
│       │   └── index.ts
│       ├── agentic_generative_ui/
│       │   ├── agent.ts
│       │   └── index.ts
│       ├── human_in_the_loop/
│       │   ├── agent.ts
│       │   └── index.ts
│       ├── predictive_state_updates/
│       │   ├── agent.ts
│       │   └── index.ts
│       ├── shared_state/
│       │   ├── agent.ts
│       │   └── index.ts
│       └── tool_based_generative_ui/
│           ├── agent.ts
│           └── index.ts
├── package.json
├── tsconfig.json
├── langgraph.json
├── .env.example
└── README.md
```

## Dependencies

- `@langchain/core`: Core LangChain functionality
- `@langchain/openai`: OpenAI integration
- `@langchain/langgraph`: LangGraph for building stateful agents
- `dotenv`: Environment variable management
- `uuid`: UUID generation for tool calls
- `typescript`: TypeScript compiler

## Development

To build the project:

```bash
npm run build
```

To start development with LangGraph CLI:

```bash
npm run dev
```

## Notes

These TypeScript implementations maintain the same functionality as their Python counterparts while following TypeScript/JavaScript conventions and patterns. Each agent is fully typed and includes proper error handling and state management.
