/**
 * Human-in-the-loop example — Task planning with frontend approval.
 *
 * Demonstrates the pause/resume pattern: a tool provided by the FRONTEND via
 * `RunAgentInput.tools` that the model calls, the adapter halts the run with
 * a success outcome, the frontend renders an approval UI, the user
 * selects steps, and the frontend resumes the conversation by sending the
 * tool result back as a `tool`-role message in the next run.
 *
 * Flow:
 * 1. Model calls the `generate_task_steps` frontend tool with step data.
 * 2. Adapter emits TOOL_CALL_START/ARGS/END, then RUN_FINISHED with
 *    outcome { type: "success" } so CopilotKit can manage the pending tool.
 * 3. Frontend renders an interactive step-selection UI.
 * 4. User reviews/selects steps; frontend sends the result back as a tool
 *    message in the next request.
 * 5. The adapter turns that tool message into a `function_call_result` input
 *    item (via messagesToSdkInput) and the model continues.
 */

import { OpenAIAgentsAdapter } from "@ag-ui/openai-agents-js";
import { baseConfig } from "./constants";

const instructions = `You are a task planning assistant specialized in creating clear, actionable step-by-step plans.

## Your Primary Role
- Break down any user request into clear, actionable steps (10 by default).
- Generate steps that require human review and approval.
- Execute only human-approved steps.

## When a user requests help with a task:

1. **Create the Plan**
   - **IMMEDIATELY call the \`generate_task_steps\` tool** to create a breakdown.
   - Generate the number of steps the user asked for (or 10 by default).
   - Each step must be an object with:
     * \`description\`: Brief imperative form (e.g. "Research travel options").
     * \`status\`: Set to "enabled" initially.
   - **ALWAYS call the tool FIRST** — don't just write the steps as text.

   Example tool call:
   \`\`\`json
   {
     "steps": [
       {"description": "Research Mars travel options", "status": "enabled"},
       {"description": "Prepare necessary equipment", "status": "enabled"}
     ]
   }
   \`\`\`

2. **After Creating the Plan**
   - Briefly confirm: "I've created an N-step plan for you!"
   - DON'T repeat all the steps in your response (they're visible in the UI).
   - Ask the user to review and select which steps to perform.

3. **When the User Provides Feedback**
   - Wait for the user to select steps and click "Perform Steps".
   - The frontend sends back the tool result indicating which steps were approved.
   - Respond with execution confirmation.

## Important Rules
- **MUST call \`generate_task_steps\` for EVERY planning request.**
- NEVER write steps as plain text — ALWAYS use the tool.
- Keep your response brief after the tool call (steps are in the UI).
- DON'T call the tool twice without user input in between.
`;

/**
 * Create adapter for the human-in-the-loop demo.
 *
 * Demonstrates:
 * - Frontend tool halt → RUN_FINISHED success outcome for CopilotKit
 * - Resume by feeding the tool result back as a `tool` message
 */
export function createHumanInTheLoopAdapter(): OpenAIAgentsAdapter {
  return new OpenAIAgentsAdapter({
    agentId: "human_in_the_loop",
    description: "Task planning assistant with human approval workflow",
    ...baseConfig,
    instructions,
    interruptOnFrontendToolCall: false,
  });
}
