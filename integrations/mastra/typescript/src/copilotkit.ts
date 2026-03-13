import type { AbstractAgent } from '@ag-ui/client';
import {
  CopilotRuntime,
  copilotRuntimeNodeHttpEndpoint,
  CopilotServiceAdapter,
  ExperimentalEmptyAdapter,
} from '@copilotkit/runtime';
import type { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import type { ContextWithMastra } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import { MastraAgentAdapter } from './mastra';

/**
 * Optional hook to enrich Mastra request context before agent execution.
 * @param context Current API route context.
 * @param requestContext Mutable Mastra request context.
 */
export type SetCopilotKitContext = (
  context: ContextWithMastra,
  requestContext: RequestContext<unknown>,
) => void | Promise<void>;

/** Configuration for registering the CopilotKit API route. */
export interface RegisterCopilotKitOptions {
  /** Route path handled by `registerApiRoute`. */
  path: string;
  /** Default resource ID used for local Mastra agents. */
  resourceId: string;
  /** Optional CopilotKit service adapter override. */
  serviceAdapter?: CopilotServiceAdapter;
  /** Optional prebuilt AG-UI agents; falls back to local Mastra agents. */
  agents?: Record<string, AbstractAgent>;
  /** Optional per-request context initialization callback. */
  setContext?: SetCopilotKitContext;
}

/**
 * Registers a CopilotKit endpoint backed by Mastra AG-UI agent adapters.
 * @param options Route and runtime registration options.
 */
export function registerCopilotKit(options: RegisterCopilotKitOptions) {
  const resolvedOptions = {
    ...options,
    serviceAdapter: options.serviceAdapter ?? new ExperimentalEmptyAdapter(),
  };

  return registerApiRoute(resolvedOptions.path, {
    method: 'ALL',
    handler: async (context) => {
      const routeContext = context as ContextWithMastra;
      const mastra = routeContext.get('mastra') as Mastra;

      const requestContext = routeContext.get('requestContext') ?? new RequestContext();

      if (resolvedOptions.setContext) {
        await resolvedOptions.setContext(routeContext, requestContext);
      }

      const aguiAgents =
        resolvedOptions.agents ??
        MastraAgentAdapter.getLocalAgents({
          resourceId: resolvedOptions.resourceId,
          mastra,
          requestContext,
        });

      const runtime = new CopilotRuntime({ agents: aguiAgents });
      const handler = copilotRuntimeNodeHttpEndpoint({
        endpoint: resolvedOptions.path,
        runtime,
        serviceAdapter: resolvedOptions.serviceAdapter,
      });

      return handler(routeContext.req.raw);
    },
  });
}
