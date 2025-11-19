import { AbstractAgent } from "@ag-ui/client";
import {
  CopilotRuntime,
  copilotRuntimeNodeHttpEndpoint,
  CopilotServiceAdapter,
  ExperimentalEmptyAdapter,
} from "@copilotkit/runtime";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { registerApiRoute } from "@mastra/core/server";
import { MastraAgent } from "./mastra";
import { AgentExecutionOptions } from "@mastra/core/agent";
export function registerCopilotKit<T extends Record<string, any> | unknown = unknown>({
  path,
  resourceId,
  serviceAdapter = new ExperimentalEmptyAdapter(),
  agents,
  setContext,
  getAgentExecutionOptions,
}: {
  path: string;
  resourceId: string;
  serviceAdapter?: CopilotServiceAdapter;
  agents?: Record<string, AbstractAgent>;
  setContext?: (c: any, runtimeContext: RuntimeContext<T>) => void | Promise<void>;
  getAgentExecutionOptions?: (c: any) => AgentExecutionOptions | Promise<AgentExecutionOptions>;
}) {
  return registerApiRoute(path, {
    method: `ALL`,
    handler: async (c) => {
      const mastra = c.get("mastra");

      const runtimeContext = new RuntimeContext<T>();

      if (setContext) {
        await setContext(c, runtimeContext);
      }

      const agentExecutionOptions = getAgentExecutionOptions ? await getAgentExecutionOptions(c) : {};

      const aguiAgents =
        agents ||
        MastraAgent.getLocalAgents({
          resourceId,
          mastra,
          runtimeContext,
          agentExecutionOptions,
        });

      const runtime = new CopilotRuntime({
        agents: aguiAgents,
      });

      const handler = copilotRuntimeNodeHttpEndpoint({
        endpoint: path,
        runtime,
        serviceAdapter,
      });

      return handler.handle(c.req.raw, {});
    },
  });
}
