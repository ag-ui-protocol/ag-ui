"""Human-in-the-Loop example using AG2 with AG-UI protocol.

Exposes a ConversableAgent with a generate_task_steps tool. The tool is
executed on the frontend (HITL): the agent sends suggested steps to the UI,
the user selects which steps to run, and the result is sent back to the agent.
See: https://docs.ag2.ai/latest/docs/user-guide/ag-ui/
"""

from textwrap import dedent

from fastapi import FastAPI
from autogen import ConversableAgent, LLMConfig
from autogen.ag_ui import AGUIStream


agent = ConversableAgent(
    name="hitl_planner",
    system_message=dedent("""
        You are a collaborative planning assistant.
        When planning tasks use tools only, without any other messages.
        IMPORTANT:
        - Use the `generate_task_steps` tool to display the suggested steps to the user
        - Do not call the `generate_task_steps` twice in a row, ever.
        - Never repeat the plan, or send a message detailing steps
        - If accepted, confirm the creation of the plan and the number of selected (enabled) steps only
        - If not accepted, ask the user for more information, DO NOT use the `generate_task_steps` tool again
    """),
    llm_config=LLMConfig({"model": "gpt-4o-mini", "stream": True}),
)

stream = AGUIStream(agent)
human_in_the_loop_app = FastAPI()
human_in_the_loop_app.mount("", stream.build_asgi())
