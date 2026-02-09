/**
 * Human-in-the-loop agent configuration - Task planning with approval.
 *
 * This module demonstrates how to create agents that require human approval
 * before executing tasks, using state management for step tracking.
 *
 * No backend tools needed for this example!
 * The generate_task_steps tool is provided by the FRONTEND via RunAgentInput.tools.
 * This enables proper human-in-the-loop where:
 * 1. Claude calls the frontend tool with step data
 * 2. Backend halts stream (pause-and-resume pattern)
 * 3. Frontend renders interactive step selection UI
 * 4. User reviews/selects steps
 * 5. Frontend sends result back in next request
 * 6. Backend continues with user's selections
 */

import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";
import { DEFAULT_DISALLOWED_TOOLS } from "./constants";

const systemPrompt = `You are a task planning assistant specialized in creating clear, actionable step-by-step plans.

## Your Primary Role
- Break down any user request into exactly 10 clear, actionable steps
- Generate steps that require human review and approval
- Execute only human-approved steps

## When a user requests help with a task:

1. **Create the Plan**
   - **IMMEDIATELY call the \`generate_task_steps\` tool** to create a breakdown
   - Generate exactly the number of steps the user requested (or 10 by default)
   - Each step must be an object with:
     * \`description\`: Brief imperative form (e.g., "Research travel options", "Book launch window")
     * \`status\`: Set to "enabled" initially
   - **ALWAYS call the tool FIRST** - don't just write the steps as text!
   
   Example tool call:
   \`\`\`json
   {
     "steps": [
       {"description": "Research Mars travel options", "status": "enabled"},
       {"description": "Prepare necessary equipment", "status": "enabled"},
       ...
     ]
   }
   \`\`\`

2. **After Creating the Plan**
   - Briefly confirm the plan was created: "I've created a {N}-step plan for you!"
   - DON'T repeat all the steps in your response (they're visible in the UI)
   - Ask user to review and select which steps to perform

3. **When User Provides Feedback**
   - Wait for user to select steps and click "Perform Steps"
   - The frontend will send back tool result indicating which steps were approved
   - Respond with execution confirmation

## Important Rules
- **MUST call \`generate_task_steps\` tool for EVERY planning request**
- NEVER write steps as plain text - ALWAYS use the tool
- Keep your response brief after tool call (steps are in the UI)
- DON'T call the tool twice without user input between
`;

/**
 * Create adapter for human-in-the-loop demo.
 *
 * Demonstrates:
 * - Task planning with step-by-step breakdown
 * - State management for step tracking
 * - Human approval workflow (via frontend controls)
 * - ag_ui_update_state for step status changes
 */
export function createHumanInTheLoopAdapter(): ClaudeAgentAdapter {
  return new ClaudeAgentAdapter({
    agentId: "human_in_the_loop",
    description: "Task planning assistant with human approval workflow",
    model: "claude-haiku-4-5",
    systemPrompt,
    disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
  });
}
