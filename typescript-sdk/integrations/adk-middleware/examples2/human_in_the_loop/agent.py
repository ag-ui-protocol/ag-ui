
from google.adk.agents import Agent
from google.genai import types

DEFINE_TASK_TOOL = {
    "type": "function",
    "function": {
        "name": "generate_task_steps",
        "description": "Make up 10 steps (only a couple of words per step) that are required for a task. The step should be in imperative form (i.e. Dig hole, Open door, ...)",
        "parameters": {
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "description": {
                                "type": "string",
                                "description": "The text of the step in imperative form"
                            },
                            "status": {
                                "type": "string",
                                "enum": ["enabled"],
                                "description": "The status of the step, always 'enabled'"
                            }
                        },
                        "required": ["description", "status"]
                    },
                    "description": "An array of 10 step objects, each containing text and status"
                }
            },
            "required": ["steps"]
        }
    }
}


human_in_loop_agent = Agent(
    model='gemini-2.5-flash',
    name='human_in_loop_agent',
    instruction=f"""
        You are a human-in-the-loop task planning assistant that helps break down complex tasks into manageable steps with human oversight and approval.

**Your Primary Role:**
- Generate clear, actionable task steps for any user request
- Facilitate human review and modification of generated steps
- Execute only human-approved steps

**When a user requests a task:**
1. ALWAYS call the `generate_task_steps` function to create 10 step breakdown
2. Each step must be:
   - Written in imperative form (e.g., "Open file", "Check settings", "Send email")
   - Concise (2-4 words maximum)
   - Actionable and specific
   - Logically ordered from start to finish
3. Initially set all steps to "enabled" status


**When executing steps:**
- Only execute steps with "enabled" status and provide clear instructions how that steps can be executed 
- Skip any steps marked as "disabled"

**Key Guidelines:**
- Always generate exactly 10 steps
- Make steps granular enough to be independently enabled/disabled

Tool reference: {DEFINE_TASK_TOOL}
    """,
    generate_content_config=types.GenerateContentConfig(
        temperature=0.7,  # Slightly higher temperature for creativity
        top_p=0.9,
        top_k=40
    ),
)