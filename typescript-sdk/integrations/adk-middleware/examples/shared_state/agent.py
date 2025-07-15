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



shared_state_agent = LlmAgent(
        name="RecipeAgent",
        model="gemini-2.5-pro",
        instruction=f"""You are a helpful recipe assistant. 

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
        # output_key="last_response",  # Store the agent's response in state
        before_agent_callback=on_before_agent
        # before_model_callback=on_before_model
    )

async def run_recipe_agent(user_message: str, app_name: str = "recipe_app", 
                          user_id: str = "user1", session_id: str = "session1"):
    """
    Run the recipe agent with a user message.
    
    Args:
        user_message: The user's input message
        app_name: Application name for the session
        user_id: User identifier
        session_id: Session identifier
    
    Returns:
        The agent's response and updated session state
    """
    
    # Create session service
    
    session_service = InMemorySessionService()
    agent = LlmAgent(
        name="RecipeAgent",
        model="gemini-2.5-pro",
        instruction=f"""You are a helpful recipe assistant. 

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
        USER:{user_message}
        """,
        tools=[generate_recipe],
        # output_key="last_response",  # Store the agent's response in state
        before_agent_callback=on_before_agent
        # before_model_callback=on_before_model
    )

    # Create the agent
    # agent = create_recipe_agent()
    
    # Create runner
    runner = Runner(
        agent=agent,
        app_name=app_name,
        session_service=session_service
    )
    
    # Create or get session

    session = await session_service.get_session(
        app_name=app_name,
        user_id=user_id,
        session_id=session_id
    )
    print('session already exist with session_id',session_id)
    if not session:
        print('creating session with session_id',session_id)
        session = await session_service.create_session(
            app_name=app_name,
            user_id=user_id,
            session_id=session_id
    )

        # Create new session if it doesn't exist
    # Create user message content
    user_content = Content(parts=[Part(text=user_message)])
    print('user_message==>',user_message)
    # Run the agent
    response_content = None
    async for event in runner.run_async(
        user_id=user_id,
        session_id=session_id,
        new_message=user_content
    ):
        print(f"Event emitted: {response_content}")
        if event.is_final_response():
            response_content = event.content
            print(f"Agent responded: {response_content}")
    
    # Get updated session to check state
    updated_session = await session_service.get_session(
        app_name=app_name,
        user_id=user_id,
        session_id=session_id
    )
    
    return {
        "response": response_content,
        "recipe_state": updated_session.state.get("recipe"),
        "session_state": updated_session.state
    }


# Example usage
async def main():
    """
    Example usage of the recipe agent.
    """
    
    # Test the agent
    print("=== Recipe Agent Test ===")
    
    # First interaction - create a recipe
    result1 = await run_recipe_agent("I want to cook Biryani, create a simple Biryani recipe and use generate_recipe tool for this",session_id='123121')
    print(f"Response 1: {result1['response']}")
    print(f"Recipe State: {json.dumps(result1['recipe_state'], indent=2)}")
    
    # # Second interaction - modify the recipe
    # result2 = await run_recipe_agent("Make it vegetarian and add some herbs")
    # print(f"Response 2: {result2['response']}")
    # print(f"Updated Recipe State: {json.dumps(result2['recipe_state'], indent=2)}")
    
    # # Third interaction - adjust cooking time
    # result3 = await run_recipe_agent("Make it a quick 15-minute recipe")
    # print(f"Response 3: {result3['response']}")
    # print(f"Final Recipe State: {json.dumps(result3['recipe_state'], indent=2)}")


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())