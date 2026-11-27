import { registerApiRoute } from "@mastra/core/server";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createMastraRunGuidanceProcessor,
  isMastraRunGuidanceProcessor,
  mastraConfiguredInputProcessors,
  mastraRunGuidanceCapabilitiesPath,
  mastraRunGuidanceDeclaration,
  readMastraRunGuidanceContext,
  supportsMastraRunGuidance,
} from "./run-guidance";

const authority = new AsyncLocalStorage<boolean>();

/**
 * Runs native Mastra handlers with the authority established by server
 * authentication or an explicitly trusted ingress.
 */
export function withMastraRunGuidanceAuthority<T>(
  trusted: boolean,
  run: () => T,
): T {
  return authority.run(trusted, run);
}

/**
 * Provider-boundary receiver for agents run through native Mastra routes.
 * Add it to the agent's input processors and establish authority in server
 * middleware with `withMastraRunGuidanceAuthority`.
 */
export const mastraRunGuidanceProcessor = createMastraRunGuidanceProcessor(
  (requestContext) => ({
    context: readMastraRunGuidanceContext(requestContext),
    trusted: authority.getStore() === true,
  }),
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
