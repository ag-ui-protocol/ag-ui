"""
A chat flow for CopilotKit's generative UI (A2UI 1.0) demos.

CopilotKit sends its generative UI guide and component schema as the run's
context. The endpoint puts it in ``state.context``; the flow appends it to the
system prompt, so the model can answer with ```a2ui fences or call the
``render_ui`` frontend tool.
"""

from typing import Any

from crewai.flow.flow import Flow, start
from litellm import acompletion
from ag_ui_crewai._config import resolve_provider_timeout_seconds
from ag_ui_crewai.sdk import copilotkit_stream, CopilotKitState


def _field(item: Any, name: str) -> Any:
    return item.get(name) if isinstance(item, dict) else getattr(item, name, None)


def system_prompt_with_context(context: list) -> str:
    """The system prompt with the application's context entries appended."""
    entries = [
        f"{_field(item, 'description')}:\n{_field(item, 'value')}"
        for item in context
        if _field(item, "value")
    ]
    system_prompt = "You are a helpful assistant."
    if entries:
        system_prompt += "\n\n## Context from the application\n\n" + "\n\n".join(entries)
    return system_prompt


class GenerativeUIFlow(Flow[CopilotKitState]):

    @start()
    async def chat(self):
        response = await copilotkit_stream(
            await acompletion(
                timeout=resolve_provider_timeout_seconds(),
                model="openai/gpt-5.4",
                messages=[
                    {
                        "role": "system",
                        "content": system_prompt_with_context(self.state.context),
                    },
                    *self.state.messages
                ],
                tools=[
                    *self.state.copilotkit.actions,
                ],
                parallel_tool_calls=False,
                stream=True
            )
        )

        message = response.choices[0].message
        self.state.messages.append(message)
