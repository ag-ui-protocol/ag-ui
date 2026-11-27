import { registerApiRoute } from "@mastra/core/server";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  bridgeRunGuidanceContext,
  createMastraRunGuidanceProcessor,
  isMastraRunGuidanceProcessor,
  mastraConfiguredInputProcessors,
  mastraRunGuidanceCapabilitiesPath,
  mastraRunGuidanceDeclaration,
  readMastraRunGuidanceContext,
  supportsMastraRunGuidance,
} from "./run-guidance";

const authority = new AsyncLocalStorage<{
  trusted: boolean;
  context: readonly unknown[];
}>();

/**
 * Runs native Mastra handlers with the authority established by server
 * authentication or an explicitly trusted ingress. Supply the current
 * native request body's serialized `requestContext`. An omitted context clears
 * guidance even when Mastra restores an earlier request in its resume snapshot.
 */
export function withMastraRunGuidanceAuthority<T>(
  trusted: boolean,
  run: () => T,
  requestContext?: Record<string, unknown>,
): T {
  const context = readMastraRunGuidanceContext(requestContext?.["ag-ui"]);
  return authority.run({ trusted: trusted === true, context }, run);
}

/**
 * Provider-boundary receiver for agents run through native Mastra routes.
 * Add it to the agent's input processors and establish authority in server
 * middleware with `withMastraRunGuidanceAuthority`.
 */
export const mastraRunGuidanceProcessor = createMastraRunGuidanceProcessor(
  (requestContext) => {
    const context = requestContext?.get("ag-ui");
    if (
      typeof context === "object" &&
      context !== null &&
      bridgeRunGuidanceContext in context
    ) {
      return { context: [], trusted: false };
    }
    return (
      authority.getStore() ?? {
        context: readMastraRunGuidanceContext(context),
        trusted: false,
      }
    );
  },
);

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
        (
          await mastraConfiguredInputProcessors(
            agent,
            context.get("requestContext"),
          )
        ).some(isMastraRunGuidanceProcessor)
      ) {
        return context.json({ custom: mastraRunGuidanceDeclaration() });
      }
      return context.json({});
    },
  });
}
