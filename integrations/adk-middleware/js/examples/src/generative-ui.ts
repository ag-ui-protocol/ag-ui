import { AG_UI_CONTEXT_KEY } from "@ag-ui/adk-js";
import type { ReadonlyContext } from "@google/adk";
import { createDojoAgent } from "./factory";

type ContextEntry = { description?: string; value?: string };

/**
 * The instruction with the run's context appended. The bridge stores
 * RunAgentInput.context in session state under AG_UI_CONTEXT_KEY; for this
 * demo it carries CopilotKit's generative UI guide and component schema.
 */
function instructionWithContext(context: ReadonlyContext): string {
  const entries = (context.state.get<ContextEntry[]>(AG_UI_CONTEXT_KEY) ?? [])
    .filter((item) => item.value)
    .map((item) => `${item.description}:\n${item.value}`);
  const instruction = "You are a helpful assistant.";
  return entries.length
    ? `${instruction}\n\n## Context from the application\n\n${entries.join("\n\n")}`
    : instruction;
}

export function createGenerativeUIAgent() {
  return createDojoAgent({
    name: "adk_js_generative_ui",
    instruction: instructionWithContext,
  });
}
