# Pydantic AI

Implementation of the AG-UI protocol for [Pydantic AI](https://ai.pydantic.dev/).

For more information on the Pydantic AI implementation see
the [Pydantic AI AG-UI docs](https://ai.pydantic.dev/ag-ui/).

## Prerequisites

This example uses a Pydantic AI agent using an OpenAI model and the AG-UI dojo.

- An [OpenAI API key](https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key)

## Running

To run this integration you need to:

1. Clone the [AG-UI repository](https://github.com/ag-ui-protocol/ag-ui)

    ```shell
    git clone https://github.com/ag-ui-protocol/ag-ui.git
    ```

2. Change into the integrations/pydantic-ai/python` directory

    ```shell
    cd integrations/pydantic-ai/python
    ```

3. Install the `pydantic-ai-examples` package, for example:

    ```shell
    pip install pydantic-ai-examples
    ```

    or:

    ```shell
    uv venv
    uv pip install pydantic-ai-examples
    ```

4. Run the example dojo server

    ```shell
    export OPENAI_API_KEY=<your api key>
    python -m pydantic_ai_examples.ag_ui
    ```

    or:

    ```shell
    export OPENAI_API_KEY=<your api key>
    uv run python -m pydantic_ai_examples.ag_ui
    ```

5. Open another terminal in root directory of the `ag-ui` repository clone
6. Start the integration ag-ui dojo:

    ```shell
    pnpm install && pnpm run dev
    ```

7. Visit [http://localhost:3000/pydantic-ai](http://localhost:3000/pydantic-ai)
8. Select View `Pydantic AI` from the sidebar


## Feature Examples

### Agentic Chat

This demonstrates a basic agent interaction including Pydantic AI server side
tools and AG-UI client side tools.

View the [Agentic Chat example](http://localhost:3000/pydantic-ai/feature/agentic_chat).

#### Agent Tools

- `time` - Pydantic AI tool to check the current time for a time zone
- `background` - AG-UI tool to set the background color of the client window

#### Agent Prompts

```text
What is the time in New York?
```

```text
Change the background to blue
```

A complex example which mixes both AG-UI and Pydantic AI tools:

```text
Perform the following steps, waiting for the response of each step before continuing:
1. Get the time
2. Set the background to red
3. Get the time
4. Report how long the background set took by diffing the two times
```

### Agentic Generative UI

Demonstrates a long running task where the agent sends updates to the frontend
to let the user know what's happening.

View the [Agentic Generative UI example](http://localhost:3000/pydantic-ai/feature/agentic_generative_ui).

#### Plan Prompts

```text
Create a plan for breakfast and execute it
```

### Human in the Loop

Demonstrates simple human in the loop workflow where the agent comes up with a
plan and the user can approve it using checkboxes.

#### Task Planning Tools

- `generate_task_steps` - AG-UI tool to generate and confirm steps

#### Task Planning Prompt

```text
Generate a list of steps for cleaning a car for me to review
```

### Predictive State Updates

Demonstrates how to use the predictive state updates feature to update the state
of the UI based on agent responses, including user interaction via user
confirmation.

View the [Predictive State Updates example](http://localhost:3000/pydantic-ai/feature/predictive_state_updates).

#### Story Tools

- `write_document` - AG-UI tool to write the document to a window
- `document_predict_state` - Pydantic AI tool that enables document state
  prediction for the `write_document` tool

This also shows how to use custom instructions based on shared state information.

#### Story Example

Starting document text

```markdown
Bruce was a good dog,
```

Agent prompt

```text
Help me complete my story about bruce the dog, is should be no longer than a sentence.
```

### Shared State

Demonstrates how to use the shared state between the UI and the agent.

State sent to the agent is detected by a function based instruction. This then
validates the data using a custom pydantic model before using to create the
instructions for the agent to follow and send to the client using a AG-UI tool.

View the [Shared State example](http://localhost:3000/pydantic-ai/feature/shared_state).

#### Recipe Tools

- `display_recipe` - AG-UI tool to display the recipe in a graphical format

#### Recipe Example

1. Customise the basic settings of your recipe
2. Click `Improve with AI`

### Tool Based Generative UI

Demonstrates customised rendering for tool output with used confirmation.

View the [Tool Based Generative UI example](http://localhost:3000/pydantic-ai/feature/tool_based_generative_ui).

#### Haiku Tools

- `generate_haiku` - AG-UI tool to display a haiku in English and Japanese

#### Haiku Prompt

```text
Generate a haiku about formula 1
```
