import type { CopilotClientPort } from "../dist/index.js";
import { defineAgent } from "./base.js";

/**
 * `write_document` is a FRONTEND tool; its `document` argument streams into
 * `state.document` while the model writes it, and the browser's confirm dialog
 * resolves the suspended call on the next run.
 */
export const createPredictiveStateUpdatesAgent = (client: CopilotClientPort) =>
  defineAgent(client, {
    agentId: "predictive_state_updates",
    description: "Document editor that streams tool arguments into shared state",
    instructions: `You are a helpful assistant for writing documents.

To write or edit the document, you MUST use the \`write_document\` tool.
You MUST pass the full updated document, even when changing only a few words.
When making edits, keep them minimal: do not rewrite every word.
Format the document with markdown, but never use italic or strike-through
formatting, which is reserved for showing the user a diff.
Keep stories SHORT.

After calling the tool, do NOT repeat the document as a message. Just briefly
summarize the changes you made, 2 sentences max.`,
    predictState: [{ state_key: "document", tool: "write_document", tool_argument: "document" }],
  });
