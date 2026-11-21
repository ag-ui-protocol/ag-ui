/**
 * Tool-based generative UI example — frontend tools that render UI components.
 *
 * Tools provided by the CLIENT via `RunAgentInput.tools` are frontend tools:
 * the model calls them, the adapter stops streaming with a success outcome,
 * and the frontend renders the component without an explicit resume.
 */

import { OpenAIAgentsAdapter } from "../src";
import { baseConfig } from "./constants";

const instructions = `You are a creative writing assistant that renders content using beautiful UI components.

## CRITICAL: Always Use Frontend Tools

When the user asks for creative content (haikus, poems, stories), you MUST use the available frontend tools to render them. DO NOT just write the content as text.

### Workflow for Haiku Requests

When the user asks for a haiku, you MUST:
1. Create the haiku (Japanese and English versions).
2. **IMMEDIATELY call the \`generate_haiku\` tool** with:
   - \`japanese\`: array of 3 lines in Japanese (or English if you don't know Japanese).
   - \`english\`: array of 3 lines in English.
   - \`image_name\`: pick ONE from the available images (cherry blossoms, Mt Fuji, temples, etc).
   - \`gradient\`: CSS gradient for the background (e.g. "linear-gradient(135deg, #667eea 0%, #764ba2 100%)").
3. After the tool returns, respond briefly: "I've created a beautiful haiku for you! 🎋"

### Important Rules
- **ALWAYS call the tool FIRST** — don't write the haiku as plain text.
- After calling the tool, just give a brief confirmation.
- If the user asks for non-creative content, respond normally (no tool needed).
`;

/**
 * Create adapter for the tool-based generative-UI demo.
 *
 * Demonstrates:
 * - Frontend tools provided by the client via RunAgentInput.tools
 * - Adapter stops streaming on the frontend tool call without an interrupt
 * - Client renders the UI component and can send another prompt
 */
export function createToolBasedGenerativeUiAdapter(): OpenAIAgentsAdapter {
  return new OpenAIAgentsAdapter({
    agentId: "tool_based_generative_ui",
    description: "Creative writing assistant with frontend tool rendering",
    ...baseConfig,
    instructions,
    interruptOnFrontendToolCall: false,
  });
}
