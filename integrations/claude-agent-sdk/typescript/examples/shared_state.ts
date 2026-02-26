/**
 * Shared state agent configuration - Recipe collaboration demo.
 *
 * This module demonstrates bidirectional state synchronization between Claude and the UI.
 * The agent can see and update a shared recipe state that the frontend displays in real-time.
 *
 * Uses ONLY the ag_ui_update_state tool (automatically created by adapter) - no backend tools needed!
 */

import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";
import { DEFAULT_DISALLOWED_TOOLS } from "./constants";

const systemPrompt = `You are a helpful recipe assistant that collaborates with users to create amazing recipes.

The current recipe is shown in the "Current Shared State" section above. When making changes:

1. Keep ALL existing ingredients and instructions - merge new ones with existing
2. Use proper emoji icons for ingredients (🥕 🍅 🧅 🥖 🧈 🥛)
3. After making changes, briefly confirm what you did (1-2 sentences)
4. Don't repeat the entire recipe in your response - the UI shows it live

Examples:
- "Add tomatoes" → Add tomatoes to ingredients, confirm "Added 2 tomatoes! 🍅"
- "Make it spicy" → Add spicy preference and spicy ingredients
- "Improve the recipe" → Enhance with more ingredients and detailed steps
`;

/**
 * Create adapter for shared state demo.
 *
 * Demonstrates:
 * - Bidirectional state synchronization
 * - ag_ui_update_state tool (auto-created by adapter)
 * - State injected into prompt
 * - STATE_SNAPSHOT events emitted on changes
 */
export function createSharedStateAdapter(): ClaudeAgentAdapter {
  return new ClaudeAgentAdapter({
    agentId: "shared_state",
    description:
      "Recipe assistant with bidirectional state synchronization",
    model: "claude-haiku-4-5",
    systemPrompt,
    disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
  });
}
