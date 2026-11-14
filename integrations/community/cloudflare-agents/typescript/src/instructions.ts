import type { Context } from "@ag-ui/client";

export interface InstructionsParts {
  /** The agent's own instructions. */
  base?: string;
  /** Text of the conversation's `system` and `developer` messages. */
  systemMessages?: string[];
  /** `RunAgentInput.context`: what the application tells the agent. */
  context?: Context[];
  /** The shared state, or undefined to leave it out. */
  state?: unknown;
}

/**
 * Builds the system instructions for a run: the agent's own instructions,
 * then the conversation's system messages, the application's context and the
 * shared state, each in its own section and each left out when empty.
 */
export function buildInstructions({ base, systemMessages, context, state }: InstructionsParts): string {
  const sections: string[] = [];
  if (base?.trim()) sections.push(base.trim());
  for (const message of systemMessages ?? []) {
    if (message.trim()) sections.push(message.trim());
  }

  const contextText = formatContext(context);
  if (contextText) {
    sections.push(`Context from the application:\n${contextText}`);
  }

  const stateText = formatState(state);
  if (stateText) {
    sections.push(
      `Shared state (the application shows it to the user and can change it):\n${stateText}`,
    );
  }
  return sections.join("\n\n");
}

/** One `- description: value` line per context entry. */
export function formatContext(context: Context[] | undefined): string {
  return (context ?? [])
    .filter((entry) => entry.description || entry.value)
    .map((entry) => `- ${entry.description}: ${entry.value}`)
    .join("\n");
}

function formatState(state: unknown): string {
  if (state === undefined || state === null) return "";
  if (typeof state === "object" && Object.keys(state as object).length === 0) return "";
  try {
    return JSON.stringify(state, null, 2);
  } catch {
    return "";
  }
}
