# Server Starter (All Features)

This is a starter kit for demonstrating each feature of AG-UI by sending static events to the frontend.

## Running the server

To run the server:

```bash
cd typescript-sdk/integrations/server-starter-all-features/server/python

poetry install && poetry run dev
```

## Integrations

- **Agentic Chat**:

Demonstrates chatting with an agent and frontend tool calling. (send it a literal "tool" as a chat message to trigger the tool call)

Source: ➡️ [example_server/agentic_chat.py](https://github.com/ag-ui-protocol/ag-ui/blob/main/typescript-sdk/integrations/server-starter-all-features/server/python/example_server/agentic_chat.py)

- **Human in the Loop**:

A simple human in the loop workflow where the agent comes up with a plan and the user can approve it using checkboxes.

Source: ➡️ [example_server/human_in_the_loop.py](https://github.com/ag-ui-protocol/ag-ui/blob/main/typescript-sdk/integrations/server-starter-all-features/server/python/example_server/human_in_the_loop.py)

- **Agentic Generative UI**:

Simulates a long running task where the agent sends updates to the frontend to let the user know what's happening.

Source: ➡️ [example_server/agentic_generative_ui.py](https://github.com/ag-ui-protocol/ag-ui/blob/main/typescript-sdk/integrations/server-starter-all-features/server/python/example_server/agentic_generative_ui.py)

- **Tool Based Generative UI**:

Simulates a server tool call that is rendered in the frontend.

Source: ➡️ [example_server/tool_based_generative_ui.py](https://github.com/ag-ui-protocol/ag-ui/blob/main/typescript-sdk/integrations/server-starter-all-features/server/python/example_server/tool_based_generative_ui.py)

- **Shared State**:

Demonstrates how to use the shared state between the user and the agent.

Source: ➡️ [example_server/shared_state.py](https://github.com/ag-ui-protocol/ag-ui/blob/main/typescript-sdk/integrations/server-starter-all-features/server/python/example_server/shared_state.py)

- **Predictive State Updates**:

Demonstrates how to use the predictive state updates feature to update the state of the agent based on the user's input.

Source: ➡️ [example_server/predictive_state_updates.py](https://github.com/ag-ui-protocol/ag-ui/blob/main/typescript-sdk/integrations/server-starter-all-features/server/python/example_server/predictive_state_updates.py)
