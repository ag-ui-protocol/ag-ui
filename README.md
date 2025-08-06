
# <img src="https://github.com/user-attachments/assets/ebc0dd08-8732-4519-9b6c-452ce54d8058" alt="ag-ui Logo" width="22"/> AG-UI: The Agent-User Interaction Protocol

AG-UI is a lightweight, event-based protocol that standardizes how AI agents connect to user-facing applications.
Built for simplicity and flexibility, it enables seamless integration between AI agents, real time user context, and user interfaces.

---

[📅 Upcoming Event: August 6th - AG-UI + Mastra: Build a Project Management Canvas](https://lu.ma/94688z7e)

<br>


[![Version](https://img.shields.io/npm/v/@ag-ui/core?label=Version&color=6963ff&logo=npm&logoColor=white)](https://www.npmjs.com/package/@ag-ui/core)
![MIT](https://img.shields.io/github/license/copilotkit/copilotkit?color=%236963ff&label=License)
![Discord](https://img.shields.io/discord/1379082175625953370?logo=discord&logoColor=%23FFFFFF&label=Discord&color=%236963ff)

  <a href="https://discord.gg/Jd3FzfdJa8" target="_blank">
   Join our Discord →
  </a> &nbsp;&nbsp;&nbsp;
    <a href="https://ag-ui.com/" target="_blank">
   Read the Docs →
  </a> &nbsp;&nbsp;&nbsp;
    <a href="https://x.com/CopilotKit" target="_blank">
   Follow us →
  </a> 

<img width="4096" height="1752" alt="Your application-AG-UI protocol" src="https://github.com/user-attachments/assets/dc58c64c-3257-490a-b827-e163475f4166" />

## 🚀 Getting Started
Create a new AG-UI application in seconds:
```bash
npx create-ag-ui-app my-agent-app
```
<h3>Building AG-UI Integrations (new frameworks):</h3>

- [Build new integrations (Quickstart)](https://go.copilotkit.ai/agui-contribute)
- [Book a call to discuss an AG-UI integration with a new framework](https://calendly.com/markus-copilotkit/ag-ui)
- [Join the Discord Community](https://discord.gg/Jd3FzfdJa8)

## What is AG-UI?

AG-UI is an open, lightweight, event-based protocol for agent-human interaction, designed for simplicity & flexibility:

- During agent executions, agent backends **emit events _compatible_ with one of AG-UI's ~16 standard event types**
- Agent backends can **accept one of a few simple AG-UI compatible inputs** as arguments

**AG-UI includes a flexible middleware layer** that ensures compatibility across diverse environments:

- Works with **any event transport** (SSE, WebSockets, webhooks, etc.)
- Allows for **loose event format matching**, enabling broad agent and app interoperability

It also ships with a **reference HTTP implementation** and **default connector** to help teams get started fast.


[Learn more about the specs →](https://go.copilotkit.ai/ag-ui-introduction)


## Why AG-UI?

AG-UI was developed based on real-world requirements and practical experience building in-app agent interactions.


## Where does AGUI fit in the agentic protocol stack?
AG-UI is complementary to the other 2 top agentic protocols
- MCP gives agents tools
- A2A allows agents to communicate with other agents
- AG-UI brings agents into user-facing applications

<div align="center">
  <img width="2048" height="1182" alt="The Agent Protocol Stack" src="https://github.com/user-attachments/assets/41138f71-50be-4812-98aa-20e0ad595716" />
</div>  
   
## 🚀 Features

- 💬 Real-time agentic chat with streaming
- 🔄 Bi-directional state synchronization
- 🧩 Generative UI and structured messages
- 🧠 Real-time context enrichment
- 🛠️ Frontend tool integration
- 🧑‍💻 Human-in-the-loop collaboration


## 🛠 Supported Frameworks

AG-UI was born from CopilotKit's initial partnership with LangGraph and CrewAI - and brings the incredibly popular agent-user-interactivity infrastructure to the wider agentic ecosystem.

| Framework                                                          | Status                   | AG-UI Resources                                                              | Integrations |
| ------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------- | ------------------------ |
| No-framework                                                       | ✅ Supported             | ➡️ Docs coming soon                                                          |                          |
| [LangGraph](https://www.langchain.com/langgraph)                   | ✅ Supported             | ➡️ [Demo](https://v0-langgraph-land.vercel.app/)                             | Partnership              |
| [CrewAI](https://crewai.com/)                                      | ✅ Supported             | ➡️ [Demo](https://v0-crew-land.vercel.app/)                                  | Partnership              |
| [Mastra](https://mastra.ai/)                                       | ✅ Supported             | ➡️ [Demo](https://v0-mastra-land.vercel.app/)                                | 1st party                |
| [AG2](https://ag2.ai/)                                             | ✅ Supported             | ➡️ [Demo](https://v0-ag2-land.vercel.app/)                                   | 1st party                |
| [Agno](https://github.com/agno-agi/agno)                           | ✅ Supported             | ➡️ [Docs](https://docs.copilotkit.ai/agno)                                   | 1st party                |
| [LlamaIndex](https://github.com/run-llama/llama_index)             | ✅ Supported             | ➡️ [Docs](https://docs.copilotkit.ai/llamaindex)                             | 1st party                |
| [Pydantic AI](https://github.com/pydantic/pydantic-ai)             | ✅ Supported             | ➡️ [Docs](https://docs.copilotkit.ai/pydantic-ai)                            | 1st party                |
| [Vercel AI SDK](https://github.com/vercel/ai)                      | 🛠️ In Progress           | –                                                                            | Community                |
| [Google ADK](https://google.github.io/adk-docs/get-started/)       | 🛠️ In Progress           | –                                                                            | Community                |
| [OpenAI Agent SDK](https://openai.github.io/openai-agents-python/) | 🛠️ In Progress           | –                                                                            | Community                |
| [AWS Bedrock Agents](https://aws.amazon.com/bedrock/agents/)       | 🛠️ In Progress           | –                                                                            | 1st party                |
| [Cloudflare Agents](https://developers.cloudflare.com/agents/)     | 💡 Open to Contributions | –                                                                            | Community                |
| [Strands Agents SDK](https://github.com/strands-agents/sdk-python) | 💡 Open to Contributions | –                                                                            | Community                |   

[View all supported frameworks →](https://ag-ui.com/frameworks)


| Language SDK                                                       | Status                    | AG-UI Resources                                                              |
| ------------------------------------------------------------------ | ------------------------  | ---------------------------------------------------------------------------- |
| [Kotlin]()                                                         | ✅ Supported              | ➡️ [GitHub Source](https://github.com/Contextable/ag-ui-4k)                  |
| [.NET]()                                                           | 🛠️ In Progress            | ➡️ [PR](https://github.com/ag-ui-protocol/ag-ui/pull/38)                     |
| [Nim]()                                                            | 🛠️ In Progress            | ➡️ [PR](https://github.com/ag-ui-protocol/ag-ui/pull/29)                     |
| [Golang]()                                                         | 🛠️ In Progress            | ➡️ [Issue](https://github.com/ag-ui-protocol/ag-ui/issues/156)               |
| [Rust]()                                                           | 🛠️ In Progress            | ➡️ [Issue](https://github.com/ag-ui-protocol/ag-ui/issues/239)               |
| [Java]()                                                           | 💡 Open to Contributions  | ➡️ [Issue](https://github.com/ag-ui-protocol/ag-ui/issues/20)                |


[View all supported frameworks →](https://ag-ui.com/frameworks)


## ✨ Hello World App


Video:

https://github.com/user-attachments/assets/18c03330-1ebc-4863-b2b8-cc6c3a4c7bae

https://agui-demo.vercel.app/



## 🧩 AG-UI Showcase: The AG-UI Dojo (Building-Blocks Viewer)
The [AG-UI Dojo](https://copilotkit-feature-viewer.vercel.app/) showcases many of the building blocks that AG-UI supports ([AG-UI Dojo Source Code](https://github.com/ag-ui-protocol/ag-ui/tree/main/typescript-sdk/apps/dojo)).

The building blocks are designed to be simple and focused -- between 50-200 lines of code.

https://github.com/user-attachments/assets/a67d3d54-36b2-4c7a-ac69-a0ca01365d5b


## 🙋🏽‍♂️ Contributing to AG-UI

Check out the [Contributing guide](https://github.com/ag-ui-protocol/ag-ui/blob/main/CONTRIBUTING.md)

- **[Weekely AG-UI Working Group](https://lu.ma/CopilotKit?k=c)**  
  📅 Follow the CopilotKit Luma Events Calendar

## Roadmap

Check out the [AG-UI Roadmap](https://github.com/orgs/ag-ui-protocol/projects/1) to see what's being built and where you can jump in.


## 📄 License

AG-UI is open source software [licensed as MIT](https://opensource.org/licenses/MIT).  
Maintained by [AG Protocol](https://www.agprotocol.ai).
