# SuperOptiX AG-UI Integration

This integration enables [SuperOptiX](https://superoptix.ai) agents to work seamlessly with the AG-UI ecosystem. SuperOptiX is a [DSPy](https://dspy.ai)-powered agent framework for agent development and optimization.

## 🚀 Quick Start

### Prerequisites
- Python 3.12+
- Node.js 18+
- SuperOptiX CLI

### Installation

1. **Install SuperOptiX CLI:**
   ```bash
   pip install superoptix
   ```

2. **Install AG-UI SuperOptiX packages:**
   ```bash
   # Install Python package
   cd typescript-sdk/integrations/superoptix/python
   pip install -e .
   
   # Install TypeScript package (from typescript-sdk root)
   cd ../../..
   pnpm install
   ```

### Setup SuperOptiX Project

1. **Create a SuperOptiX project:**
   ```bash
   super init swe
   cd swe
   ```

2. **Pull and compile an agent:**
   ```bash
   super agent pull developer
   super agent compile developer
   ```

3. **Configure the server:**
   - Edit `typescript-sdk/integrations/superoptix/python/example_server.py`
   - Update `PROJECT_ROOT` to point to your SuperOptiX project
   - Update `AGENT_NAME` if using a different agent

### Running the Integration

1. **Start the SuperOptiX server:**
   ```bash
   cd typescript-sdk/integrations/superoptix/python
   python example_server.py
   ```

2. **Start the AG-UI dojo:**
   ```bash
   cd typescript-sdk/apps/dojo
   pnpm dev
   ```

3. **Test the integration:**
   - Open `http://localhost:3000/superoptix/feature/agentic_chat`
   - Start chatting with your SuperOptiX agent!

## 📁 Project Structure

```
typescript-sdk/integrations/superoptix/
├── python/
│   ├── example_server.py          # AG-UI server with setup instructions
│   ├── ag_ui_superoptix/         # AG-UI integration package
│   └── README.md                  # This file
├── src/                           # TypeScript SDK
└── README.md                      # Integration documentation
```

## 🔧 Configuration

### Server Configuration

The `example_server.py` file contains configuration options:

```python
# Update these paths to match your setup
PROJECT_ROOT = Path("/path/to/your/superoptix/project")
AGENT_NAME = "developer"  # Your agent name
```

### Environment Variables

- `PORT`: Server port (default: 8000)
- `SUPEROPTIX_URL`: SuperOptiX server URL (default: http://localhost:8000)

## 🎯 Available Features

Test these SuperOptiX features in the AG-UI dojo:

- **Agentic Chat**: `http://localhost:3000/superoptix/feature/agentic_chat`
- **Human in the Loop**: `http://localhost:3000/superoptix/feature/human_in_the_loop`
- **Tool-based Generative UI**: `http://localhost:3000/superoptix/feature/tool_based_generative_ui`
- **Agentic Generative UI**: `http://localhost:3000/superoptix/feature/agentic_generative_ui`
- **Shared State**: `http://localhost:3000/superoptix/feature/shared_state`
- **Predictive State Updates**: `http://localhost:3000/superoptix/feature/predictive_state_updates`

## 🛠️ Troubleshooting

### Common Issues

1. **"SuperOptiX project not found"**
   - Ensure you ran `super init` and created a project
   - Update `PROJECT_ROOT` in `example_server.py`

2. **"Agent not found"**
   - Run `super agent pull developer` and `super agent compile developer`
   - Verify the agent name in `AGENT_NAME`

3. **"404 Not Found" errors**
   - Ensure SuperOptiX server is running on port 8000
   - Check that both servers are accessible

4. **Build errors**
   - Run `pnpm build` in typescript-sdk directory
   - Ensure all dependencies are installed

### Debugging

- Check server logs for Python errors
- Check browser console for JavaScript errors
- Verify SuperOptiX project structure with `.super` file and agents directory

## 📚 Additional Resources

- [SuperOptiX Documentation](https://superoptix.ai)
- [AG-UI Documentation](https://docs.ag-ui.com)
- [DSPy Documentation](https://dspy.ai)

## 🤝 Contributing

This integration follows the standard AG-UI integration patterns. See the main AG-UI repository for contribution guidelines.
