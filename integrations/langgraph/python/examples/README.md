# LangGraph examples

## How to run

First, make sure to create a new .env file from the .env.example and include the required keys.

To run the Python examples for langgraph platform, run:

```
cd integrations/langgraph/python/examples
pnpx @langchain/langgraph-cli@1.1.13 dev
```

Run the FastAPI examples with uv from the repository checkout.

```sh
cd integrations/langgraph/python/examples
uv sync --frozen
uv run --frozen dev
```

The example's uv configuration uses the AG-UI packages from this checkout.
If you host the example against published packages, use an `ag-ui-langgraph`
release or preview that exports the run guidance middleware and agent mixin.

## Per-run guidance on the FastAPI chat example

The stock `/agent/agentic_chat` endpoint advertises `openbot.runGuidance` at
`/agent/agentic_chat/capabilities`. Include the current `OpenBot standing role`
and `OpenBot granted tools guidance` entries in `RunAgentInput.context` on each
run and tool-result continuation.

- Set `AG_UI_GUIDANCE_TOKEN` on the server and send the same token in the
  `Authorization: Bearer …` header for capability lookup and runs.
- Set `AG_UI_TRUSTED_INGRESS=true` if deployment access controls restrict this
  endpoint to authorized callers. This mode can run without a separate token.
- With both values unset, the role reaches the model as ordinary user guidance.
  Tool guidance is available only to authorized requests.

To host just the stock chat agent, import
`create_fastapi_agent` from `agents.agentic_chat.fastapi` and serve its return
value with `ag_ui_langgraph.add_langgraph_fastapi_endpoint`.
