# Claude Agent SDK Integration Examples

This directory contains example implementations of the Claude Agent SDK integration with AG-UI Protocol.

## Quick Start

1. Install dependencies:
```bash
cd examples
pip install -r requirements.txt
# Or using uv:
uv pip install -r requirements.txt
```

2. Set your Anthropic API key:
```bash
export ANTHROPIC_API_KEY=your-api-key-here
```

3. Run the example server:
```bash
python server/fastapi_server.py
# Or using uv:
uv run server/fastapi_server.py
```

4. The server will be available at `http://localhost:8000/chat`

## Example Usage

The example server demonstrates:
- Basic Claude Agent configuration
- FastAPI server setup
- AG-UI Protocol endpoint integration

## Notes

This implementation is a template based on common patterns. You may need to adjust:
- Claude SDK client initialization
- Message format conversion
- Tool handling
- Session management

Refer to the Claude Agent SDK documentation for actual API details.

