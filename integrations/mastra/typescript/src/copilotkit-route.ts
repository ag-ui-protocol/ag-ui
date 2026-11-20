import {
  MASTRA_RESOURCE_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import { ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import {
  MastraAgent,
  type MastraSubagentToolResults,
  type MastraSubagentVisibility,
  MastraTracingOptions,
} from "./mastra";

/**
 * `Omit` that distributes over each member of a union, so a discriminated union
 * (e.g. `CopilotRuntimeOptions`) keeps its discriminant correlation. Plain
 * `Omit<A | B, K>` collapses to `Omit<A & B, K>` because `keyof (A | B)` is only
 * the shared keys, which destroys the union.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** The options of `registerCopilotKit` that are not CopilotKit runtime options. */
export interface CopilotKitRouteOptions<Cors> {
  path: string;
  resourceId: string;
  /**
   * Mastra tracing options forwarded to each agent run (default-agent path
   * only; ignored when `agents` is supplied since those are pre-constructed).
   * See MastraAgentConfig.tracingOptions.
   */
  tracingOptions?: MastraTracingOptions;
  /**
   * How delegated sub-agents reach the stream (default-agent path only).
   * See MastraAgentConfig.subagentVisibility.
   */
  subagentVisibility?: MastraSubagentVisibility;
  /**
   * What attributed sub-agents' tool results carry (default-agent path only).
   * See MastraAgentConfig.subagentToolResults.
   */
  subagentToolResults?: MastraSubagentToolResults;
  /**
   * Hook to populate the request context before agents run. It runs inside the
   * route handler, i.e. *after* any Mastra server middleware, so the
   * `requestContext` it receives already holds whatever keys that middleware
   * set. Be careful not to clobber those keys (e.g. `MASTRA_RESOURCE_ID_KEY`)
   * unless that is the intent.
   */
  setContext?: (
    c: ContextWithMastra,
    requestContext: RequestContext,
  ) => void | Promise<void>;
  cors?: boolean | Cors;
}

/**
 * The two values of a CopilotKit runtime module that the route uses. CopilotKit
 * 1.x exports them from `@copilotkit/runtime/v2`, CopilotKit 2.x from
 * `@copilotkit/runtime`; the signatures are the same.
 */
export interface CopilotKitRuntimeModule {
  CopilotRuntime: new (options: any) => unknown;
  createCopilotRuntimeHandler: (
    options: any,
  ) => (request: Request) => Response | Promise<Response>;
}

/**
 * The Mastra API route of `registerCopilotKit`, for the CopilotKit runtime
 * module of one CopilotKit major version.
 */
export function createCopilotKitRoute<
  Options extends CopilotKitRouteOptions<unknown> & { agents?: unknown },
>(
  copilotKit: CopilotKitRuntimeModule,
  {
    path,
    resourceId,
    setContext,
    agents,
    cors,
    tracingOptions,
    subagentVisibility,
    subagentToolResults,
    ...runtimeOptions
  }: Options,
) {
  return registerApiRoute(path, {
    method: `ALL`,
    handler: async (c) => {
      const mastra = c.get("mastra");
      const requestContext = c.get("requestContext");

      if (setContext) {
        await setContext(c, requestContext);
      }

      const aguiAgents =
        agents ||
        MastraAgent.getLocalAgents({
          resourceId:
            requestContext.get<
              typeof MASTRA_RESOURCE_ID_KEY,
              string | undefined
            >(MASTRA_RESOURCE_ID_KEY) ?? resourceId,
          mastra,
          requestContext,
          tracingOptions,
          subagentVisibility,
          subagentToolResults,
        });

      const runtime = new copilotKit.CopilotRuntime({
        ...runtimeOptions,
        agents: aguiAgents,
      });

      const handler = copilotKit.createCopilotRuntimeHandler({
        runtime,
        basePath: path,
        cors,
        mode: "single-route",
      });

      // CopilotKit forwards `authorization` and `x-*` headers onto the agent
      // (`configureAgentForRequest` → `extractForwardableHeaders`), and
      // `@ag-ui/mastra` then passes the agent's headers as
      // `modelSettings.headers` into the model call. That would forward our
      // Mastra Authorization to our AI provider and clobber the provider's real
      // Authorization header. Mastra has already authenticated this request by
      // now, so drop the header before the runtime sees it.
      const headers = new Headers(c.req.raw.headers);
      headers.delete("authorization");

      return handler(new Request(c.req.raw, { headers }));
    },
  });
}
