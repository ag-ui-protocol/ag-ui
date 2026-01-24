"""Shared State example for Langroid.

Demonstrates bidirectional state synchronization between agent and UI for recipe collaboration.
"""
import json
import os
import logging
from pathlib import Path
from typing import Dict, Any
from dotenv import load_dotenv

env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

import langroid as lr
from langroid.agent import ChatAgent, ChatAgentConfig, ToolMessage
from langroid.language_models import OpenAIChatModel, OpenAIGPTConfig

from ag_ui_langroid import LangroidAgent, create_langroid_app
from ag_ui_langroid.types import ToolBehavior, LangroidAgentConfig, ToolCallContext

logger = logging.getLogger(__name__)


class GenerateRecipeTool(ToolMessage):
    """Generate or update a recipe."""
    request: str = "generate_recipe"
    purpose: str = """
        Generate or update a recipe using the provided recipe data.
        Always provide the COMPLETE recipe, not just the changes.
        Include all fields: title, skill_level, special_preferences, cooking_time, ingredients, instructions, and changes.
    """
    recipe: Dict[str, Any]


llm_config = OpenAIGPTConfig(
    chat_model=OpenAIChatModel.GPT4o,
    api_key=os.getenv("OPENAI_API_KEY"),
)


class RecipeAssistantAgent(ChatAgent):
    """ChatAgent with recipe generation capabilities and shared state support."""
    
    def __init__(self, config: ChatAgentConfig):
        super().__init__(config)
        self.enable_message(GenerateRecipeTool)
    
    def generate_recipe(self, msg: GenerateRecipeTool) -> str:
        """Handle generate_recipe tool execution. State snapshot is emitted via state_from_args."""
        return json.dumps({"status": "success", "message": "Recipe generated successfully"})


def build_state_context(input_data, user_message: str) -> str:
    """Inject current recipe state into prompt."""
    state_dict = getattr(input_data, "state", None) or {}
    if isinstance(state_dict, dict) and "recipe" in state_dict:
        recipe_json = json.dumps(state_dict["recipe"], indent=2)
        return (
            f"Current recipe state:\n{recipe_json}\n\n"
            f"User request: {user_message}\n\n"
            "Please update the recipe by calling the generate_recipe tool with the COMPLETE updated recipe."
        )
    return user_message


async def recipe_state_from_args(context: ToolCallContext):
    """Emit recipe snapshot as soon as tool arguments are available."""
    try:
        if hasattr(context.tool_input, "recipe"):
            recipe_dict = context.tool_input.recipe
            if isinstance(recipe_dict, dict):
                return {"recipe": recipe_dict}
        
        if context.args_str:
            args_data = json.loads(context.args_str)
            recipe_dict = args_data.get("recipe")
            if isinstance(recipe_dict, dict):
                return {"recipe": recipe_dict}
        
        return None
    except Exception as e:
        logger.warning(f"Error in recipe_state_from_args: {e}", exc_info=True)
        return None


agent_config = ChatAgentConfig(
    name="RecipeAssistant",
    llm=llm_config,
    system_message="""You are a helpful recipe assistant. When asked to improve or modify a recipe:

1. Call the generate_recipe tool ONCE with the COMPLETE updated recipe
2. Include ALL fields: title, skill_level, special_preferences, cooking_time, ingredients, instructions, and changes
3. After calling the tool, respond to the user with a brief confirmation of what you changed (1-2 sentences)
4. Do NOT call the tool multiple times in a row
5. Keep existing elements that aren't being changed

Be creative and helpful!""",
    use_tools=True,
    use_functions_api=False,
)

chat_agent = RecipeAssistantAgent(agent_config)

task = lr.Task(
    chat_agent,
    name="RecipeAssistant",
    interactive=False,
    single_round=False,
)

shared_state_config = LangroidAgentConfig(
    tool_behaviors={
        "generate_recipe": ToolBehavior(
            state_from_args=recipe_state_from_args,
        )
    },
    state_context_builder=build_state_context,
)

agui_agent = LangroidAgent(
    agent=task,
    name="shared_state",
    description="A recipe assistant that collaborates with you to create amazing recipes",
    config=shared_state_config,
)

app = create_langroid_app(agui_agent, "/")

