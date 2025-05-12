
[![AG-UI Working Group #1 – May 16](https://img.shields.io/badge/AG--UI%20Working%20Group%20%231%E2%80%94May%2016-blue?style=flat-square)](https://lu.ma/8supz1j0)
[![Bring Agents Into Apps with AG-UI – May 16](https://img.shields.io/badge/Bring%20Agents%20Into%20Apps%20with%20AG--UI%E2%80%94May%2016-blue?style=flat-square)](https://lu.ma/c58yhgij)


# <img src="https://github.com/user-attachments/assets/ebc0dd08-8732-4519-9b6c-452ce54d8058" alt="ag-ui Logo" height="42px" /> AG-UI

AG-UI is an open, lightweight, event-based protocol that standardizes **how AI agents connect to front-end applications**.


<img src="https://github.com/user-attachments/assets/215227a5-9698-4d97-a46e-8904b95bfa08" alt="ag-ui Logo" height="300px" />





## AG-UI Specification

AG-UI is an open, lightweight, event-based, (maximally-accomodating) protocol for agent-human interaction:
* During agent executions, agent backends **emit events _compatible_ with one of AG-UI's 16 standard event types**
* Agents can **accept one of a few simple AG-UI compatible inputs**

AG-UI has a built-in middleware layer that facilitates maximal accomodation, including:
* Support for **any event transport mechanism** (SSEs, webhooks, WebSockets, etc.)
* Event **compatibility** without requiring exact format matching

AG-UI also includes a reference HTTP protocol implementation & an associated reference connector.


[Learn more at ag-ui.com](https://ag-ui.com)





## Build AG-UI-Powered Applications



https://github.com/user-attachments/assets/18c03330-1ebc-4863-b2b8-cc6c3a4c7bae




AG-UI works with several popular agent frameworks and frontend solutions:

| Framework | Status | AG-UI Resources |
|-----------|--------|-----------------|
| [LangGraph](https://www.langchain.com/langgraph) | ✅ Supported | ➡️ [Live Demo / Getting Started Docs](https://feature-viewer-langgraph.vercel.app/) |
| [Mastra](https://mastra.ai/) | ✅ Supported | ➡️ [Live Demo / Getting Started Docs](https://demo-viewer-five.vercel.app/) |
| [CrewAI](https://crewai.com/) | ✅ Supported | ➡️ [Live Demo / Getting Started Docs](https://docs.copilotkit.ai/crewai-crews) |
| [AG2](https://ag2.ai/) | ✅ Supported | ➡️ [Live Demo / Getting Started Docs](https://feature-viewer-ag2.vercel.app/) |
| [Agno](https://github.com/agno-agi/agno) | 🛠️ In Progress | – |
| [OpenAI Agent SDK](https://openai.github.io/openai-agents-python/) | 🤝 Contribution Wanted | – |
| [Google ADK](https://google.github.io/adk-docs/get-started/) | 🤝 Contribution Wanted | – |
| [Vercel AI SDK](https://github.com/vercel/ai) | 🤝 Contribution Wanted | – |
| [AWS Bedrock Agents](https://aws.amazon.com/bedrock/agents/) | 🤝 Contribution Wanted | – |
| [Cloudflare Agents](https://developers.cloudflare.com/agents/) | 🤝 Contribution Wanted | – |


## Features

AG-UI-compatible agents **securely** and **efficiently** implement support for:

- ✅ Agentic chat (with support for streaming)
- ✅ Bi-directional (agent<>app) state synchronization - for use inside & outside the chat
- ✅ Generative UI
- ✅ Structured messages with delta streaming (e.g. for thinking steps)  
- ✅ Realtime context enrichment
- ✅ Frontend tool calls
- ✅ Human in the Loop 
- ✅ Human on the Loop 

And more. [Learn more at ag-ui.com](https://ag-ui.com)

## AG-UI Showcase: The AG-UI Dojo (Building-Blocks Viewer)

The [ag-ui dojo](https://feature-viewer-langgraph.vercel.app/) showcases many of the building blocks that ag-ui supports.

The building blocks are designed to be simple and focused -- between 50-200 lines of code.


https://github.com/user-attachments/assets/a67d3d54-36b2-4c7a-ac69-a0ca01365d5b



## Client Libraries

- **React client:** CopilotKit – [Documentation](http://copilotkit.ai/docs)
- WhatsApp, WeChat, and RCS client (WIP, in partnership with the AWS SNS Team)

## Build New AG-UI Framework Integrations

Learn how to build AG-UI hooks for a new framework: [Framework Integration Guide](http://agui.com/build-hooks)


## Community

### Upcoming Events

- **[AG-UI: How to Bring AI Agents Into Frontend Applications](https://lu.ma/c58yhgij)**  
  📅 Friday, May 16, 9:00 AM PT  
  🔗 [lu.ma/c58yhgij](https://lu.ma/c58yhgij)

- **[AG-UI Protocol Working Group #1](https://lu.ma/8supz1j0)**  
  📅 Friday, May 16, 10:00 AM PT  
  🔗 [lu.ma/8supz1j0](https://lu.ma/8supz1j0)
  
## Contributing

We 💜 contributions! Whether you're fixing bugs, improving documentation, or building demos — your contributions make AG-UI better.
