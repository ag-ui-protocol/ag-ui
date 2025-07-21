"""
A demo of shared state between the agent and CopilotKit using Google ADK.
"""

from dotenv import load_dotenv
load_dotenv()
import json
from enum import Enum
from typing import Dict, List, Any, Optional
# ADK imports
from google.adk.agents import LlmAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.sessions import InMemorySessionService, Session
from google.adk.runners import Runner
from google.adk.events import Event, EventActions
from google.adk.tools import FunctionTool, ToolContext
from google.genai.types import Content, Part , FunctionDeclaration
from google.adk.models import LlmResponse, LlmRequest
from google.genai import types


from pydantic import BaseModel, Field
from typing import List, Optional
from enum import Enum

class SkillLevel(str, Enum):
    # Add your skill level values here
    BEGINNER = "beginner"
    INTERMEDIATE = "intermediate"
    ADVANCED = "advanced"

class SpecialPreferences(str, Enum):
    # Add your special preferences values here
    VEGETARIAN = "vegetarian"
    VEGAN = "vegan"
    GLUTEN_FREE = "gluten_free"
    DAIRY_FREE = "dairy_free"
    KETO = "keto"
    LOW_CARB = "low_carb"

class CookingTime(str, Enum):
    # Add your cooking time values here
    QUICK = "under_30_min"
    MEDIUM = "30_60_min"
    LONG = "over_60_min"

class Ingredient(BaseModel):
    icon: str = Field(..., description="The icon emoji of the ingredient")
    name: str
    amount: str

class Recipe(BaseModel):
    skill_level: SkillLevel = Field(..., description="The skill level required for the recipe")
    special_preferences: Optional[List[SpecialPreferences]] = Field(
        None, 
        description="A list of special preferences for the recipe"
    )
    cooking_time: Optional[CookingTime] = Field(
        None, 
        description="The cooking time of the recipe"
    )
    ingredients: List[Ingredient] = Field(..., description="Entire list of ingredients for the recipe")
    instructions: List[str] = Field(..., description="Entire list of instructions for the recipe")
    changes: Optional[str] = Field(
        None, 
        description="A description of the changes made to the recipe"
    )

def generate_recipe(
    tool_context: ToolContext,
    skill_level: str,
    special_preferences: str = "",
    cooking_time: str = "",
    ingredients: List[dict] = [],
    instructions: List[str] = [],
    changes: str = ""
) -> Dict[str, str]:
    """
    Generate or update a recipe using the provided recipe data.
    
    Args:
        "skill_level": {
            "type": "string",
            "enum": ["Beginner","Intermediate","Advanced"],
            "description": "**REQUIRED** - The skill level required for the recipe. Must be one of the predefined skill levels (Beginner, Intermediate, Advanced)."
        },
        "special_preferences": {
            "type": "string",
            "description": "**OPTIONAL** - Special dietary preferences for the recipe as comma-separated values. Example: 'High Protein, Low Carb, Gluten Free'. Leave empty or omit if no special preferences."
        },
        "cooking_time": {
            "type": "string",
            "enum": [5 min, 15 min, 30 min, 45 min, 60+ min],
            "description": "**OPTIONAL** - The total cooking time for the recipe. Must be one of the predefined time slots (5 min, 15 min, 30 min, 45 min, 60+ min). Omit if time is not specified."
        },
        "ingredients": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "icon": {"type": "string", "description": "The icon emoji (not emoji code like '\x1f35e', but the actual emoji like 🥕) of the ingredient"},
                    "name": {"type": "string"},
                    "amount": {"type": "string"}
                }
            },
            "description": "Entire list of ingredients for the recipe, including the new ingredients and the ones that are already in the recipe"
        },
        "instructions": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Entire list of instructions for the recipe, including the new instructions and the ones that are already there"
            },
        "changes": {
            "type": "string",
            "description": "**OPTIONAL** - A brief description of what changes were made to the recipe compared to the previous version. Example: 'Added more spices for flavor', 'Reduced cooking time', 'Substituted ingredient X for Y'. Omit if this is a new recipe."
        }
    
    Returns:
        Dict indicating success status and message
    """
    try:

        
        # Create RecipeData object to validate structure
        recipe = {
            "skill_level": skill_level,
            "special_preferences": special_preferences ,
            "cooking_time": cooking_time ,
            "ingredients": ingredients ,
            "instructions": instructions ,
            "changes": changes
        }
        
        # Update the session state with the new recipe
        current_recipe = tool_context.state.get("recipe", {})
        if current_recipe:
            # Merge with existing recipe
            for key, value in recipe.items():
                if value is not None or value != "":
                    current_recipe[key] = value
        else:
            current_recipe = recipe
        
        tool_context.state["recipe"] = current_recipe
        
        # Log the update
        print(f"Recipe updated: {recipe.get('change')}")
        
        return {"status": "success", "message": "Recipe generated successfully"}
        
    except Exception as e:
        return {"status": "error", "message": f"Error generating recipe: {str(e)}"}



    
def on_before_agent(callback_context: CallbackContext):
    """
    Initialize recipe state if it doesn't exist.
    """
    print('recipe state ==>',callback_context.state.get('recipe'))
    if "recipe" not in callback_context.state:
        # Initialize with default recipe
        default_recipe =     {
            "skill_level": "Beginner",
            "special_preferences": [],
            "cooking_time": '15 min',
            "ingredients": [{"icon": "🍴", "name": "Sample Ingredient", "amount": "1 unit"}],
            "instructions": ["First step instruction"]
        }
        callback_context.state["recipe"] = default_recipe
        print("Initialized default recipe state")

    return None


# --- Define the Callback Function ---
#  modifying the agent's system prompt to incude the current state of recipe
def before_model_modifier(
    callback_context: CallbackContext, llm_request: LlmRequest
) -> Optional[LlmResponse]:
    """Inspects/modifies the LLM request or skips the call."""
    agent_name = callback_context.agent_name
    print(f"[Callback] Before model call for agent: {agent_name}")
    if agent_name == "RecipeAgent":
        recipe_json = "No recipe yet"
        if "recipe" in callback_context.state and callback_context.state["recipe"] is not None:
            try:
                recipe_json = json.dumps(callback_context.state["recipe"], indent=2)
            except Exception as e:
                recipe_json = f"Error serializing recipe: {str(e)}"
        # --- Modification Example ---
        # Add a prefix to the system instruction
        original_instruction = llm_request.config.system_instruction or types.Content(role="system", parts=[])
        prefix = f"""You are a helpful assistant for creating recipes. 
        This is the current state of the recipe: {recipe_json}
        You can improve the recipe by calling the generate_recipe tool."""
        # Ensure system_instruction is Content and parts list exists
        if not isinstance(original_instruction, types.Content):
            # Handle case where it might be a string (though config expects Content)
            original_instruction = types.Content(role="system", parts=[types.Part(text=str(original_instruction))])
        if not original_instruction.parts:
            original_instruction.parts.append(types.Part(text="")) # Add an empty part if none exist

        # Modify the text of the first part
        modified_text = prefix + (original_instruction.parts[0].text or "")
        original_instruction.parts[0].text = modified_text
        llm_request.config.system_instruction = original_instruction



    return None


shared_state_agent = LlmAgent(
        name="RecipeAgent",
        model="gemini-2.5-pro",
        instruction=f"""
        When a user asks for a recipe or wants to modify one, you MUST use the generate_recipe tool.

        IMPORTANT RULES:
        1. Always use the generate_recipe tool for any recipe-related requests
        2. When creating a new recipe, provide at least skill_level, ingredients, and instructions
        3. When modifying an existing recipe, include the changes parameter to describe what was modified
        4. Be creative and helpful in generating complete, practical recipes
        5. After using the tool, provide a brief summary of what you created or changed

        Examples of when to use the tool:
        - "Create a pasta recipe" → Use tool with skill_level, ingredients, instructions
        - "Make it vegetarian" → Use tool with special_preferences="vegetarian" and changes describing the modification
        - "Add some herbs" → Use tool with updated ingredients and changes describing the addition

        Always provide complete, practical recipes that users can actually cook.
        """,
        tools=[generate_recipe],
        before_agent_callback=on_before_agent,
        before_model_callback=before_model_modifier
    )

