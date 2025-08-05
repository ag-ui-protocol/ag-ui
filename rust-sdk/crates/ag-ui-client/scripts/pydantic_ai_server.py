# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "uvicorn == 0.34.3",
#   "pydantic-ai==0.4.10"
# ]
# ///

import uvicorn
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider

model = OpenAIModel(
    model_name="llama3.1",
    provider=OpenAIProvider(
        base_url="http://localhost:11434/v1", api_key="ollama"
    ),
)
agent = Agent(model)


@agent.tool_plain
def temperature_celsius(city: str) -> float:
    return 21.0


@agent.tool_plain
def temperature_fahrenheit(city: str) -> float:
    return 69.8


app = agent.to_ag_ui()

if __name__ == "__main__":
    uvicorn.run(app, port=3001)
