"""
Example: Agno Agent
"""

from typing import List

from agno.agent.agent import Agent
from agno.app.agui.app import AGUIApp
from agno.models.openai import OpenAIChat
from agno.tools import tool


@tool(
)
def generate_haiku(english: List[str], japanese: List[str]) -> str: # pylint: disable=unused-argument
    """
    Generate a haiku in Japanese and its English translation.

    Args:
        english: List[str]: An array of three lines of the haiku in English
        japanese: List[str]: An array of three lines of the haiku in Japanese

    Returns:
        str: A string containing the haiku in Japanese and its English translation
    """
    print(english, japanese, flush=True)
    return "Haiku generated"

agent = Agent(
    model=OpenAIChat(id="gpt-4o"),
    tools=[generate_haiku],
    description="You are a helpful assistant that can help with tasks and answer questions.",
)

agui_app = AGUIApp(
  agent=agent,
  name="Agno Agent",
  app_id="agno_agent",
  description="An helpful assistant.",
)

app = agui_app.get_app()

def main():
    """
    Serve the AG-UI app.
    """
    agui_app.serve(app="examples:app", port=8000, reload=True)

if __name__ == "__main__":
    main()
