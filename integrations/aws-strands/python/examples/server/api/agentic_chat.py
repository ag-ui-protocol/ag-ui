"""Agentic Chat example for AWS Strands.

Simple conversational agent with change_background frontend tool.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Suppress OpenTelemetry context warnings
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["OTEL_PYTHON_DISABLED_INSTRUMENTATIONS"] = "all"

from strands import Agent, tool
from strands.models.gemini import GeminiModel
from ag_ui_strands import StrandsAgent, create_strands_app

# Load environment variables from .env file
env_path = Path(__file__).parent.parent.parent / '.env'

load_dotenv(dotenv_path=env_path)

# Debug: Print API key status (first 10 chars only for security)
api_key = os.getenv("GOOGLE_API_KEY", "")

# Use Gemini model
model = GeminiModel(
    client_args={
        "api_key": os.getenv("GOOGLE_API_KEY", "your-api-key-here"),
    },
    model_id="gemini-2.5-flash",
    params={
        "temperature": 0.7,
        "max_output_tokens": 2048,
        "top_p": 0.9,
        "top_k": 40
    }
)


# Define frontend tool - registered so LLM knows about it, but returns None
# The actual execution happens on the frontend
@tool
def change_background(background: str):
    """
    Change the background color of the chat. Can be anything that the CSS background
    attribute accepts. Regular colors, linear or radial gradients etc.

    Args:
        background: The background color or gradient. Prefer gradients. Only use when asked.
    """
    # Return None - frontend will handle the actual execution
    return None

strands_agent = Agent(
    model=model,
    tools=[change_background],  # Register so LLM knows about it
    system_prompt="""
    You are a helpful assistant.
    When the user greets you, always greet them back. Your greeting should always start with "Hello".
    Your greeting should also always ask (exact wording) "how can I assist you?"
    """,
)

agui_agent = StrandsAgent(
    agent=strands_agent,
    name="agentic_chat",
    description="Conversational Strands agent with AG-UI streaming",
)

app = create_strands_app(agui_agent, "/")
