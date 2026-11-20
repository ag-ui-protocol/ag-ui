import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";

type ContextEntry = { description?: string; value?: string };

/**
 * The run's AG-UI context entries as instructions. The AG-UI bridge puts
 * RunAgentInput.context on the request context under "ag-ui"; for these demos
 * it carries CopilotKit's generative UI guide and component schema.
 */
function contextInstructions(requestContext: RequestContext): string {
  const entry = requestContext.get("ag-ui") as
    | { context?: ContextEntry[] }
    | undefined;
  const entries = (entry?.context ?? [])
    .filter((item) => item.value)
    .map((item) => `${item.description}:\n${item.value}`);
  return entries.length
    ? `\n\n## Context from the application\n\n${entries.join("\n\n")}`
    : "";
}

export const generativeUIAgent = new Agent({
  id: "generative_ui",
  name: "generative_ui",
  instructions: ({ requestContext }) =>
    "You are a helpful assistant." + contextInstructions(requestContext),
  model: "openai/gpt-4.1-mini",
});
