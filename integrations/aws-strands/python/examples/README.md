# Strands Integration (OpenAI)

This integration demonstrates how to use Strands Agents SDK with OpenAI models and AG-UI protocol.

## Prerequisites

- Python 3.12 or later
- Poetry for dependency management
- OpenAI API key
- Strands Agents SDK with OpenAI support installed

## Setup

1. Install Strands SDK with OpenAI support:
```bash
pip install 'strands-agents[openai]'
```

2. Configure OpenAI API key:
```bash
# Set your OpenAI API key (required)
export OPENAI_API_KEY=your-api-key-here
```

3. Optional: Configure OpenAI model settings:
```bash
# Set the OpenAI model to use (default: gpt-4o)
export OPENAI_MODEL=gpt-4o

# Set max tokens (default: 2000)
export OPENAI_MAX_TOKENS=2000

# Set temperature (default: 0.7)
export OPENAI_TEMPERATURE=0.7
```

4. Install dependencies:
```bash
cd integrations/aws-strands-integration/python/examples
poetry install
```

## Running the server

To run the server:

```bash
cd integrations/aws-strands-integration/python/examples

poetry install && poetry run dev
```

The server will start on `http://localhost:8000` by default. You can change the port by setting the `PORT` environment variable.

## Integration Details

This integration uses the Strands Agents SDK with OpenAI models. The server:
- Accepts AG-UI protocol requests
- Connects to OpenAI models via Strands SDK
- Streams responses back as AG-UI events
- Handles tool calls and state management

## Notes

- The integration uses OpenAI models (default: gpt-4o)
- Ensure your OpenAI API key is valid and has access to the specified model
- The integration supports streaming responses when available in the Strands SDK
- You can customize the model, max_tokens, and temperature via environment variables

