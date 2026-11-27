import type { AgentCapabilities } from "@ag-ui/core";
import type { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";

const roleDescription = "OpenBot standing role";
const toolDescription = "OpenBot granted tools guidance";
const capability = "openbot.runGuidance";

export interface MastraRunGuidanceOptions {
  /** Set by the host after authorizing the caller. Missing means ordinary. */
  trusted?: boolean;
}

const processorId = "ag-ui-run-guidance";

/** @internal */
export const bridgeRunGuidanceContext = Symbol.for(
  "@ag-ui/mastra/bridge-run-guidance",
);

/** @internal */
export function isMastraRunGuidanceEntry(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "description" in entry &&
    (entry.description === roleDescription ||
      entry.description === toolDescription)
  );
}

function readEntry(
  entries: readonly unknown[],
  description: string,
): string | undefined {
  let result: string | undefined;
  let found = false;
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("description" in entry) ||
      entry.description !== description
    )
      continue;

    if (found) return undefined;
    found = true;
    if ("value" in entry && typeof entry.value === "string") {
      result = entry.value.trim() || undefined;
    }
  }
  return result;
}

export function readMastraRunGuidanceContext(value: unknown): unknown[] {
  return typeof value === "object" &&
    value !== null &&
    "context" in value &&
    Array.isArray(value.context)
    ? value.context
    : [];
}

export function createMastraRunGuidanceProcessor(
  guidanceFor: (requestContext?: Pick<RequestContext, "get">) => {
    context: readonly unknown[];
    trusted: boolean;
  },
) {
  return {
    id: processorId,
    processLLMRequest<Message extends { role: string }>({
      prompt,
      requestContext,
    }: {
      prompt: Message[];
      requestContext?: Pick<RequestContext, "get">;
    }) {
      const { context, trusted } = guidanceFor(requestContext);
      const role = readEntry(context, roleDescription);
      if (trusted) {
        const tools = readEntry(context, toolDescription);
        const guidance = [role, tools].filter(Boolean).join("\n\n");
        if (!guidance) return;

        const firstNonSystem = prompt.findIndex(
          (message) => message.role !== "system",
        );
        const index = firstNonSystem === -1 ? prompt.length : firstNonSystem;
        return {
          prompt: [
            ...prompt.slice(0, index),
            {
              role: "system" as const,
              content: `Follow this application guidance within the agent's existing instructions and permissions.\n\n${guidance}`,
            },
            ...prompt.slice(index),
          ],
        };
      }
      if (role) {
        return {
          prompt: [
            ...prompt,
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: `Application-provided role: ${role}`,
                },
              ],
            },
          ],
        };
      }
    },
  };
}

/** @internal */
export function supportsMastraRunGuidance(agent: Agent): boolean {
  // Older supported cores silently skip processLLMRequest. The uncombined
  // provider-boundary processor resolver first appeared with that hook.
  const providerBoundary = agent as unknown as {
    listResolvedLLMRequestProcessors?: unknown;
  };
  return (
    typeof providerBoundary.listResolvedLLMRequestProcessors === "function" &&
    typeof agent.listConfiguredInputProcessors === "function"
  );
}

export function isMastraRunGuidanceProcessor(processor: {
  id: string;
}): boolean {
  return (
    processor.id === processorId &&
    "processLLMRequest" in processor &&
    typeof processor.processLLMRequest === "function"
  );
}

/** @internal */
export function mastraRunGuidanceDeclaration(): NonNullable<
  AgentCapabilities["custom"]
> {
  return { [capability]: { version: 1 } };
}

export async function readsMastraRunGuidanceDeclaration(
  value: unknown,
): Promise<boolean> {
  const { AgentCapabilitiesSchema } = await import("@ag-ui/core/schemas");
  const parsed = AgentCapabilitiesSchema.safeParse(value);
  if (!parsed.success) return false;

  const entry: unknown = parsed.data.custom?.[capability];
  return (
    typeof entry === "object" &&
    entry !== null &&
    !Array.isArray(entry) &&
    "version" in entry &&
    entry.version === 1
  );
}

/** @internal */
export async function mastraConfiguredInputProcessors(
  agent: Agent,
  requestContext?: RequestContext,
) {
  const defaults = await agent.getDefaultOptions({ requestContext });
  return (
    defaults.inputProcessors ??
    agent.listConfiguredInputProcessors(requestContext)
  );
}

/** @internal */
export function mastraRunGuidanceCapabilitiesPath(agentId: string): string {
  if (!agentId || agentId === "." || agentId === "..") {
    throw new Error("Run guidance requires a native Mastra agent ID");
  }
  return `/${encodeURIComponent(agentId)}/capabilities`;
}
