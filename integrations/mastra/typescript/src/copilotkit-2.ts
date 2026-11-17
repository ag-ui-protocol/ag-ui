import {
  AgentsConfig,
  CopilotCorsConfig,
  CopilotRuntime,
  CopilotRuntimeOptions,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime";
import {
  createCopilotKitRoute,
  type CopilotKitRouteOptions,
  type DistributiveOmit,
} from "./copilotkit-route";

/**
 * Registers a CopilotKit endpoint that exposes Mastra agents through the AG-UI protocol.
 * This function creates an API route that handles CopilotKit requests and forwards them to Mastra agents, enabling seamless integration between CopilotKit's UI components and Mastra's agent framework.
 *
 * For CopilotKit 2.x. With CopilotKit 1.x, import it from
 * `@ag-ui/mastra/copilotkit`.
 *
 * @example
 * ```ts
 * registerCopilotKit({
 *   path: "/api/copilotkit"
 * });
 * ```
 */
export function registerCopilotKit(
  options: CopilotKitRouteOptions<CopilotCorsConfig> &
    DistributiveOmit<CopilotRuntimeOptions, "agents"> & {
      agents?: AgentsConfig;
    },
) {
  return createCopilotKitRoute(
    { CopilotRuntime, createCopilotRuntimeHandler },
    options,
  );
}
