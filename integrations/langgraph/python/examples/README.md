# LangGraph examples

## How to run

First, make sure to create a new .env file from the .env.example and include the required keys.

To run the Python examples for langgraph platform, run:
```
cd integrations/langgraph/python/examples
pnpx @langchain/langgraph-cli@1.1.13 dev
```

To run the python examples using FastAPI, run:
```
cd integrations/langgraph/python/examples
uv sync
uv run dev
```
