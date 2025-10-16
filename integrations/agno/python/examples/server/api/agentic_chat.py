"""Example: Agno Agent with Finance tools

This example shows how to create an Agno Agent with tools (YFinanceTools) and expose it in an AG-UI compatible way.
"""
from agno.agent.agent import Agent
from agno.app.agui.app import AGUIApp
from agno.models.openai import OpenAIChat
from agno.tools.yfinance import YFinanceTools
from agno.tools import tool


@tool(external_execution=True)
def change_background(background: str) -> str: # pylint: disable=unused-argument
    """
    Change the background color of the chat. Can be anything that the CSS background attribute accepts. Regular colors, linear of radial gradients etc.

    Args:
        background: str: The background color to change to. Can be anything that the CSS background attribute accepts. Regular colors, linear of radial gradients etc.
    """ # pylint: disable=line-too-long

agent = Agent(
  model=OpenAIChat(id="gpt-4o"),
  tools=[
    YFinanceTools(
      stock_price=True, analyst_recommendations=True, stock_fundamentals=True
    ),
    change_background,
  ],
  description="You are an investment analyst that researches stock prices, analyst recommendations, and stock fundamentals.",
  instructions="Format your response using markdown and use tables to display data where possible.",
)

agui_app = AGUIApp(
  agent=agent,
  name="Investment Analyst",
  app_id="agentic_chat",
  description="An investment analyst that researches stock prices, analyst recommendations, and stock fundamentals.",
)

app = agui_app.get_app()