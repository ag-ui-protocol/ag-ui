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

### Public and restricted keyless listeners

Run separate instances of the same app when you need both public access and
keyless system guidance for a trusted backend. The example below assumes the
public reverse proxy and the backend run on the same host as Uvicorn.
Configure the proxy to route public requests only to port 8000. Before
enabling trust on port 8001, restrict access to that listener to the trusted
backend. Use host isolation or a network ACL as appropriate. Keep port 8001
out of public proxy routes, port mappings, and load balancers.

From this directory, after `uv sync --frozen`, run these commands in separate
terminals or services:

```sh
# Public instance, reachable through your public reverse proxy.
AG_UI_GUIDANCE_TOKEN='' AG_UI_TRUSTED_INGRESS=false \
  uv run --frozen uvicorn agents.dojo:app \
    --host 127.0.0.1 --port 8000 --workers 1
```

```sh
# Keyless instance, reachable only by the trusted backend.
AG_UI_GUIDANCE_TOKEN='' AG_UI_TRUSTED_INGRESS=true \
  uv run --frozen uvicorn agents.dojo:app \
    --host 127.0.0.1 --port 8001 --workers 1
```

Point public clients to your public URL. For a trusted backend on the same
host, use `http://127.0.0.1:8001/agent/agentic_chat`. If the backend runs on
another host, first restrict access to the private port to that backend,
then bind the keyless listener to the appropriate private interface. Require
TLS with authenticated endpoints or an encrypted tunnel for all traffic
between the backend and the keyless listener. Point the backend to the
protected internal URL.
Configure the backend to use that same listener for capability lookup, runs,
and tool-result continuations.

The stock chat uses an in-memory checkpointer, so each process has its own
threads and pending tool calls. Keep a conversation and its continuations on
the same instance. If you configure persistent state, use separate checkpoint
stores or namespaces for the public and restricted instances.

### Hosting your own graph

To host just the stock chat agent, import
`create_fastapi_agent` from `agents.agentic_chat.fastapi` and serve its return
value with `ag_ui_langgraph.add_langgraph_fastapi_endpoint`.

The factory enables run guidance by default. Pass `enable_run_guidance=False`
to keep CopilotKit's existing prompt handling and skip capability registration.

To enable the same behavior on your own `LangGraphAgent` endpoint, rebuild
the chat graph with `RunGuidanceMiddleware` and serve it through an adapter
that includes `RunGuidanceAgentMixin`. See the
[existing graph example](../README.md#run-guidance-for-existing-graphs).
