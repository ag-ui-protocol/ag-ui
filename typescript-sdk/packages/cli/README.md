# create-ag-ui-app

CLI tool for scaffolding **Agent-User Interaction (AG-UI) Protocol** applications.

`create-ag-ui-app` provides an interactive setup wizard to quickly bootstrap AG-UI projects with your preferred client framework and agent backend. Choose from CopilotKit/Next.js for web apps or CLI clients for terminal-based interactions.

## Installation

```bash
npm create ag-ui-app@latest
pnpm create ag-ui-app@latest
yarn create ag-ui-app
```

## Features

- 🎯 **Interactive setup** – Guided prompts for client and framework selection
- 🌐 **Multiple clients** – CopilotKit/Next.js web apps and CLI clients
- 🔧 **Framework integration** – Built-in support for LangGraph, CrewAI, Mastra, AG2, and more
- 📦 **Zero config** – Automatically sets up dependencies and project structure
- ⚡ **Quick start** – Get from idea to running app in minutes

## Quick example

```bash
# Interactive setup
npm create ag-ui-app@latest

# With framework flags
npm create ag-ui-app@latest -- --langgraph
npm create ag-ui-app@latest -- --mastra
```

## Documentation

- Concepts & architecture: [`docs/concepts`](https://docs.ag-ui.com/concepts/architecture)
- Full API reference: [`docs/quickstart`](https://docs.ag-ui.com/quickstart/introduction)

## Contributing

Bug reports and pull requests are welcome! Please read our [contributing guide](https://docs.ag-ui.com/development/contributing) first.

## License

MIT © 2025 AG-UI Protocol Contributors
