import { AbstractAgent } from "@ag-ui/client";
import {
  CopilotRuntime,
  copilotRuntimeNodeHttpEndpoint,
  CopilotServiceAdapter,
  ExperimentalEmptyAdapter,
} from "@copilotkit/runtime";
import { RequestContext } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import { MastraAgent } from "./mastra";

type CopilotRuntimeParams = NonNullable<
  ConstructorParameters<typeof CopilotRuntime>[0]
>;

/**
 * Registers a CopilotKit endpoint that exposes Mastra agents through the AG-UI protocol.
 * This function creates an API route that handles CopilotKit requests and forwards them to Mastra agents, enabling seamless integration between CopilotKit's UI components and Mastra's agent framework.
 *
 * @example
 * ```ts
 * registerCopilotKit({
 *   path: "/api/copilotkit",
 *   resourceId: "my-agent",
 *   a2ui: { injectA2UITool: true },
 * });
 * ```
 */
export function registerCopilotKit<
  T extends Record<string, any> | unknown = unknown,
>({
  path,
  resourceId,
  serviceAdapter = new ExperimentalEmptyAdapter(),
  agents,
  setContext,
  a2ui,
  mcpApps,
  openGenerativeUI,
}: {
  path: string;
  resourceId: string;
  serviceAdapter?: CopilotServiceAdapter;
  agents?: Record<string, AbstractAgent>;
  setContext?: (
    c: any,
    requestContext: RequestContext<T>,
  ) => void | Promise<void>;
  a2ui?: CopilotRuntimeParams["a2ui"];
  mcpApps?: CopilotRuntimeParams["mcpApps"];
  openGenerativeUI?: CopilotRuntimeParams["openGenerativeUI"];
}) {
  return registerApiRoute(path, {
    method: `ALL`,
    handler: async (c) => {
      const mastra = c.get("mastra");

      const requestContext = new RequestContext<T>();

      if (setContext) {
        await setContext(c, requestContext);
      }

      const aguiAgents =
        agents ||
        MastraAgent.getLocalAgents({
          resourceId,
          mastra,
          requestContext: requestContext as RequestContext,
        });

      const runtime = new CopilotRuntime({
        agents: aguiAgents as any,
        a2ui,
        mcpApps,
        openGenerativeUI,
      });

      const handler = copilotRuntimeNodeHttpEndpoint({
        endpoint: path,
        runtime,
        serviceAdapter,
      });

      return handler(c.req.raw);
    },
  });
}
