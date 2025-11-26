# @ag-ui/langchain

Implementation of the AG-UI protocol for LangChain.

## Installation

```bash
npm install @ag-ui/langchain
pnpm add @ag-ui/langchain
yarn add @ag-ui/langchain
```

## Usage

```ts
import { LangChainAgent } from "@ag-ui/langchain";

// Create an AG-UI compatible agent
const agent = new LangChainAgent({
    chainFn: async ({ messages, tools, threadId }) => {
        // Your chosen llm model
        const { ChatOpenAI } = await import("@langchain/openai");
        const chatOpenAI = new ChatOpenAI({ model: "gpt-4o" });
        const model = chatOpenAI.bindTools(tools, {
            strict: true,
        });
        return model.stream(messages, { tools, metadata: { conversation_id: threadId } });
    },
})
```
