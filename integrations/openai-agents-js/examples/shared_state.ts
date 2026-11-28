/**
 * Shared state example — Recipe collaboration demo.
 *
 * Demonstrates bidirectional state synchronization between the model and the
 * UI. The agent sees the shared recipe state and updates it by calling the
 * `ag_ui_update_state` tool, which the adapter auto-injects when the run
 * carries state and intercepts to emit `STATE_SNAPSHOT` events.
 *
 * NOTE: this adapter uses **replace** state semantics — the model passes the
 * *complete* updated state object in the `state` field (not a patch/delta).
 * The prompt therefore tells the model to return the full recipe each time.
 */

import { OpenAIAgentsAdapter } from "../src";
import { baseConfig } from "./constants";

const instructions = `You are a helpful recipe assistant that collaborates with users to create amazing recipes.

The current recipe is shown in the "Current Shared State" section above. When making changes, call the ag_ui_update_state tool with the COMPLETE updated recipe in its "state" field.

IMPORTANT — the tool call must follow this exact shape (replace, not patch):
{
  "state": {
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
1. Always pass the FULL recipe object — the state is replaced, not merged.
2. Each ingredient MUST have "icon" (emoji), "name" (string), and "amount" (string).
3. Instructions MUST be an array of strings.
4. Preserve existing ingredients/instructions the user wants to keep.
5. After making changes, briefly confirm what you did (1–2 sentences). Don't repeat the whole recipe — the UI shows it live.
`;

/**
 * Create adapter for the shared-state demo.
 *
 * Demonstrates:
 * - Bidirectional state synchronization
 * - ag_ui_update_state tool (auto-injected by the adapter)
 * - STATE_SNAPSHOT emitted on changes (replace semantics)
 */
export function createSharedStateAdapter(): OpenAIAgentsAdapter {
  return new OpenAIAgentsAdapter({
    agentId: "shared_state",
    description: "Recipe assistant with bidirectional state synchronization",
    ...baseConfig,
    instructions,
  });
}
