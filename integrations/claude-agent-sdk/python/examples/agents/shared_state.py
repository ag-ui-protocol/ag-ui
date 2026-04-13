"""
Shared state agent configuration - Recipe collaboration demo.

This module demonstrates bidirectional state synchronization between Claude and the UI.
The agent can see and update a shared recipe state that the frontend displays in real-time.

Uses ONLY the ag_ui_update_state tool (automatically created by adapter) - no backend tools needed!
"""

from ag_ui_claude_sdk import ClaudeAgentAdapter
from .constants import DEFAULT_DISALLOWED_TOOLS


def create_shared_state_adapter() -> ClaudeAgentAdapter:
    """Create adapter for shared state demo."""
    system_prompt = """You are a helpful recipe assistant that collaborates with users to create amazing recipes.

The current recipe is shown in the "Current Shared State" section above. When making changes, call the ag_ui_update_state tool with a "state_updates" object containing a "recipe" key.

IMPORTANT - The state_updates must follow this exact structure:
{
  "state_updates": {
    "recipe": {
      "title": "Recipe Name",
      "skill_level": "Beginner" | "Intermediate" | "Advanced",
      "cooking_time": "5 min" | "15 min" | "30 min" | "45 min" | "60+ min",
      "special_preferences": ["High Protein", "Spicy"],
      "ingredients": [
        { "icon": "🍝", "name": "Spaghetti", "amount": "200 grams" },
        { "icon": "🍅", "name": "Tomato Sauce", "amount": "1 cup" }
      ],
      "instructions": [
        "Step 1 description",
        "Step 2 description"
      ]
    }
  }
}

Rules:
1. Each ingredient MUST be an object with "icon" (emoji), "name" (string), and "amount" (string)
2. Instructions MUST be an array of strings
3. Keep ALL existing ingredients and instructions - merge new ones with existing
4. Use proper emoji icons for ingredients
5. After making changes, briefly confirm what you did (1-2 sentences)
6. Don't repeat the entire recipe in your response - the UI shows it live
"""
    
    return ClaudeAgentAdapter(
        name="shared_state",
        description="Recipe assistant with bidirectional state synchronization",
        options={
            "model": "claude-haiku-4-5",
            "system_prompt": system_prompt,
            "disallowed_tools": list(DEFAULT_DISALLOWED_TOOLS),
        }
    )
