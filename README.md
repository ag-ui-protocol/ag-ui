[![AG-UI Workshop – June 5](https://img.shields.io/badge/AG--UI%20Workshop%20%E2%80%94June%2019-blue?style=flat-square)](https://go.copilotkit.ai/ag-ui-build-an-agent-canvas)
![Discord](https://img.shields.io/discord/1379082175625953370?logo=discord&logoColor=%23FFFFFF&label=Discord&color=%236963ff)

AG-UI is a lightweight, event-based protocol that standardizes how AI agents connect to front-end applications. Built for simplicity and flexibility, it enables seamless integration between your AI agents and user interfaces.


# <img src="https://github.com/user-attachments/assets/ebc0dd08-8732-4519-9b6c-452ce54d8058" alt="ag-ui Logo" height="42px" /> AG-UI: The Agent-User Interaction Protocol

![0613](https://github.com/user-attachments/assets/bec3bc01-d8f2-4667-885e-028cbcbc8439)



# What is AG-UI? (Specification)

AG-UI is an open, lightweight, event-based protocol for agent-human interaction, designed for simplicity & flexibility:

- During agent executions, agent backends **emit events _compatible_ with one of AG-UI's ~16 standard event types**
- Agent backends can **accept one of a few simple AG-UI compatible inputs** as arguments

**AG-UI includes a flexible middleware layer** that ensures compatibility across diverse environments:

- Works with **any event transport** (SSE, WebSockets, webhooks, etc.)
- Allows for **loose event format matching**, enabling broad agent and app interoperability

It also ships with a **reference HTTP implementation** and **default connector** to help teams get started fast.

[Learn more about the specs](https://docs.ag-ui.com/introduction)


## Where does AGUI fit in the agentic protocol stack?
AG-UI is complementary to the other 2 top agentic protocols
- MCP gives agents tools
- A2A allows agents to communicate with other agents
- AG-UI brings agents into user-facing applications
  

    
<img src="https://github.com/user-attachments/assets/8cdaa246-2eb9-4f51-9a2c-c3991b064bb2" height="500px" />
    


  

## Features

- 💬 Real-time agentic chat with streaming
- 🔄 Bi-directional state synchronization
- 🧩 Generative UI and structured messages
- 🧠 Real-time context enrichment
- 🛠️ Frontend tool integration
- 🧑‍💻 Human-in-the-loop collaboration

## Framework Support

AG-UI integrates with many popular agent frameworks

| Framework                                                          | Status                   | AG-UI Resources                                                              |
| ------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------- |
| No-framework                                            | ✅ Supported             | ➡️ Docs coming soon       |
| [LangGraph](https://www.langchain.com/langgraph)                   | ✅ Supported             | ➡️ [Live Demo / Getting Started Docs](https://v0-langgraph-land.vercel.app/) |
| [Mastra](https://mastra.ai/)                                       | ✅ Supported             | ➡️ [Live Demo / Getting Started Docs](https://v0-mastra-land.vercel.app/)    |
| [CrewAI](https://crewai.com/)                                      | ✅ Supported             | ➡️ [Live Demo / Getting Started Docs](https://v0-crew-land.vercel.app/)      |
| [AG2](https://ag2.ai/)                                             | ✅ Supported             | ➡️ [Live Demo / Getting Started Docs](https://v0-ag2-land.vercel.app/)       |
| [Agno](https://github.com/agno-agi/agno)                           | 🛠️ In Progress           | –                                                                            |
| [LlamaIndex](https://github.com/run-llama/llama_index)                            | 🛠️ In Progress           | –                                                                            |
| [Pydantic AI](https://github.com/pydantic/pydantic-ai)                            | 🛠️ In Progress           | –                                                                            |
| [Vercel AI SDK](https://github.com/vercel/ai)                      | 🛠️ In Progress           | –                                                                            |
| [OpenAI Agent SDK](https://openai.github.io/openai-agents-python/) | 💡 Open to Contributions | –                                                                            |
| [Google ADK](https://google.github.io/adk-docs/get-started/)       | 💡 Open to Contributions | –                                                                            |
| [AWS Bedrock Agents](https://aws.amazon.com/bedrock/agents/)       | 💡 Open to Contributions | –                                                                            |
| [Cloudflare Agents](https://developers.cloudflare.com/agents/)     | 💡 Open to Contributions | –                                                                            |
| [Strands Agents SDK](https://github.com/strands-agents/sdk-python) | 💡 Open to Contributions | –                                                                            |

| Language SDK                                                      | Status                | AG-UI Resources                                                                 |
| ------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------- |
| [.NET]()                                                           | 🛠️ In Progress               | ➡️ [PR](https://github.com/ag-ui-protocol/ag-ui/pull/38)                 |
| [Nim]()                                                            | 🛠️ In Progress               | ➡️ [PR](https://github.com/ag-ui-protocol/ag-ui/pull/29)                 |
| [Rust]()                                                           | 🛠️ In Progress               |                    |


[View all supported frameworks →](https://ag-ui.com/frameworks)



## AG-UI Hello World

Play with this hello-world app here: https://agui-demo.vercel.app/

[Video:](https://github.com/user-attachments/assets/18c03330-1ebc-4863-b2b8-cc6c3a4c7bae)


## AG-UI Showcase: The AG-UI Dojo (Building-Blocks Viewer)
The AG-UI Dojo showcases many of the building blocks that AG-UI supports.

The building blocks are designed to be simple and focused -- between 50-200 lines of code.

## Getting Started

Choose your path:

### Building AG-UI Powered Applications

Create a new AG-UI application in seconds:

```bash
npx create-ag-ui-app my-agent-app
```

[View Documentation](https://ag-ui.com) · [Join Discord](https://discord.gg/Jd3FzfdJa8) · 

### Building AG-UI Integrations (new frameworks)

1. [Build new integrations (Quickstart)](https://docs.ag-ui.com/quickstart/introduction)
2. [Book a call to discuss an AG-UI integration with a new framework](https://calendly.com/markus-copilotkit/ag-ui)
3. [Join the Discord Community](https://discord.gg/Jd3FzfdJa8)


## Contributing

Check out the [Contributing guide](https://github.com/ag-ui-protocol/ag-ui/blob/main/CONTRIBUTING.md)


## License

AG-UI is open source and available under the MIT License.
