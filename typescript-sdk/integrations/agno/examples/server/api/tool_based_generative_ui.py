"""Example: Tool-based Generative UI Agent

This example shows how to create an Agno Agent with custom tools for haiku generation
and background changing, exposed in an AG-UI compatible way.
"""
from typing import List

from agno.agent.agent import Agent
from agno.app.agui.app import AGUIApp
from agno.models.openai import OpenAIChat
from agno.tools import tool


@tool()
def generate_haiku(english: List[str], japanese: List[str]) -> str: # pylint: disable=unused-argument
    """
    Generate a haiku in Japanese and its English translation.
    YOU MUST PROVIDE THE ENGLISH HAIKU AND THE JAPANESE HAIKU.

    Args:
        english: List[str]: An array of three lines of the haiku in English. YOU MUST PROVIDE THE ENGLISH HAIKU.
        japanese: List[str]: An array of three lines of the haiku in Japanese. YOU MUST PROVIDE THE JAPANESE HAIKU.

    Returns:
        str: A confirmation message.
    """ # pylint: disable=line-too-long
    return "Haiku generated"


@tool(external_execution=True)
def change_background(background: str) -> str: # pylint: disable=unused-argument
    """
    Change the background color of the chat. Can be anything that the CSS background attribute accepts. Regular colors, linear of radial gradients etc.

    Args:
        background: str: The background color to change to. Can be anything that the CSS background attribute accepts. Regular colors, linear of radial gradients etc.
    """ # pylint: disable=line-too-long

agent = Agent(
    model=OpenAIChat(id="gpt-4o"),
    tools=[generate_haiku, change_background],
    description="You are a helpful assistant that can help with tasks and answer questions.",
)

agui_app = AGUIApp(
  agent=agent,
  name="Tool-based Generative UI Agent",
  app_id="tool_based_generative_ui",
  description="A tool-based generative UI agent with haiku generation and background changing capabilities.",
)

app = agui_app.get_app()