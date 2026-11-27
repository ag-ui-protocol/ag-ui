import type { AgentCapabilities } from "@ag-ui/core";
import type { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import { AsyncLocalStorage } from "node:async_hooks";

const roleDescription = "OpenBot standing role";
const toolDescription = "OpenBot granted tools guidance";
const capability = "openbot.runGuidance";

const authority = new AsyncLocalStorage<{
  trusted: boolean;
  context?: readonly unknown[];
}>();

/**
 * Runs native Mastra handlers with the authority established by server
 * authentication or an explicitly trusted ingress.
 */
export function withMastraRunGuidanceAuthority<T>(
  trusted: boolean,
  run: () => T,
): T {
  return authority.run({ trusted }, run);
}

export interface MastraRunGuidanceOptions {
  /** Set by the host after authorizing the caller. Missing means ordinary. */
  trusted?: boolean;
}

/** @internal */
export function withMastraRunGuidanceContext<T>(
  context: readonly unknown[],
  run: () => T,
  trusted: boolean,
): T {
  return authority.run({ trusted, context }, run);
}

/** @internal */
export function isMastraRunGuidanceEntry(entry: {
  description: string;
}): boolean {
  return (
    entry.description === roleDescription ||
    entry.description === toolDescription
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

function readContext(
  requestContext: Pick<RequestContext, "get"> | undefined,
): unknown[] {
  const value = requestContext?.get("ag-ui");
  return typeof value === "object" &&
    value !== null &&
    "context" in value &&
    Array.isArray(value.context)
    ? value.context
    : [];
}

/**
 * Provider-boundary receiver for agents run through native Mastra routes.
 * Add it to the agent's input processors and establish authority in server
 * middleware with `withMastraRunGuidanceAuthority`.
 */
export const mastraRunGuidanceProcessor = {
  id: "ag-ui-run-guidance",
  processLLMRequest<Message extends { role: string }>({
    prompt,
    requestContext,
  }: {
    prompt: Message[];
    requestContext?: Pick<RequestContext, "get">;
  }) {
    const scope = authority.getStore();
    const context = scope?.context ?? readContext(requestContext);
    const role = readEntry(context, roleDescription);
    if (scope?.trusted === true) {
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

/** @internal */
export function hasMastraRunGuidanceProcessor(
  processors: { id: string }[],
): boolean {
  return processors.some(
    (processor) =>
      processor.id === mastraRunGuidanceProcessor.id &&
      "processLLMRequest" in processor &&
      typeof processor.processLLMRequest === "function",
  );
}

/** @internal */
export function mastraRunGuidanceDeclaration(): NonNullable<
  AgentCapabilities["custom"]
> {
  return { [capability]: { version: 1 } };
}

/** @internal */
export function readsMastraRunGuidanceDeclaration(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("custom" in value))
    return false;
  const custom = value.custom;
  if (
    typeof custom !== "object" ||
    custom === null ||
    Array.isArray(custom) ||
    !Object.hasOwn(custom, capability)
  )
    return false;
  const entry = (custom as Record<string, unknown>)[capability];
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

/**
 * Serves native Mastra capability discovery for an agent with the packaged
 * processor. Apply the same authentication and authorization as its run routes.
 */
export function registerMastraRunGuidanceCapabilities(agentId: string) {
  return registerApiRoute(mastraRunGuidanceCapabilitiesPath(agentId), {
    method: "GET",
    handler: async (context) => {
      const agent = context.get("mastra").getAgentById(agentId);
      if (
        supportsMastraRunGuidance(agent) &&
        hasMastraRunGuidanceProcessor(
          await mastraConfiguredInputProcessors(
            agent,
            context.get("requestContext"),
          ),
        )
      ) {
        return context.json({ custom: mastraRunGuidanceDeclaration() });
      }
      return context.json({});
    },
  });
}
