# LangGraph examples

## How to run

First, make sure to create a new .env file from the .env.example and include the required keys.

To run the Python examples for langgraph platform, run:
```
cd typescript-sdk/integrations/langgraph/examples/python
pnpx @langchain/langgraph-cli@latest dev
```

To run the python examples using FastAPI, run:
```
cd typescript-sdk/integrations/langgraph/examples/python
poetry install
poetry run dev
```

