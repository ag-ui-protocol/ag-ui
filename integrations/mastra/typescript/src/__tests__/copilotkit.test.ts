import type { AbstractAgent } from '@ag-ui/client';
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { RequestContext } from '@mastra/core/request-context';
import { MastraAgentAdapter } from '../mastra';

type RegisteredRoute = {
  path: string;
  options: {
    method: string;
    handler: (context: unknown) => Promise<unknown>;
  };
};

const registerApiRouteMock = mock((path: string, options: RegisteredRoute['options']) => ({
  path,
  options,
}));
const endpointHandlerMock = mock((request: Request) => new Response(request.url));
const copilotRuntimeNodeHttpEndpointMock = mock(() => endpointHandlerMock);
const copilotRuntimeConstructorMock = mock((options: unknown) => options);

class MockCopilotRuntime {
  constructor(options: unknown) {
    copilotRuntimeConstructorMock(options);
  }
}

class MockExperimentalEmptyAdapter {}

await mock.module('@mastra/core/server', () => ({
  registerApiRoute: registerApiRouteMock,
}));

await mock.module('@copilotkit/runtime', () => ({
  CopilotRuntime: MockCopilotRuntime,
  copilotRuntimeNodeHttpEndpoint: copilotRuntimeNodeHttpEndpointMock,
  ExperimentalEmptyAdapter: MockExperimentalEmptyAdapter,
}));

const copilotkitModule = await import('../copilotkit');
const registerCopilotKit = copilotkitModule.registerCopilotKit;

beforeEach(() => {
  registerApiRouteMock.mockClear();
  endpointHandlerMock.mockClear();
  copilotRuntimeNodeHttpEndpointMock.mockClear();
  copilotRuntimeConstructorMock.mockClear();
});

function createRouteContext(options: {
  mastra: unknown;
  request?: RequestContext<unknown>;
  rawRequest?: Request;
}): {
  get: (key: string) => unknown;
  req: { raw: Request };
} {
  const store = new Map<string, unknown>([['mastra', options.mastra]]);
  if (options.request) {
    store.set('requestContext', options.request);
  }

  return {
    get(key: string) {
      return store.get(key);
    },
    req: {
      raw: options.rawRequest ?? new Request('https://example.test/copilotkit'),
    },
  };
}

describe('registerCopilotKit', () => {
  test('creates a RequestContext when routeContext does not provide one', async () => {
    const aguiAgents: Record<string, AbstractAgent> = {};
    const getLocalAgentsSpy = spyOn(MastraAgentAdapter, 'getLocalAgents').mockReturnValue(aguiAgents);
    let capturedRequestContext: RequestContext<unknown> | undefined;

    const route = registerCopilotKit({
      path: '/copilotkit',
      resourceId: 'user-123',
      setContext: (_context, requestContext) => {
        capturedRequestContext = requestContext;
      },
    }) as unknown as RegisteredRoute;

    const routeContext = createRouteContext({
      mastra: { listAgents: () => ({}) },
    });

    await route.options.handler(routeContext);

    const getLocalAgentsArgs = getLocalAgentsSpy.mock.calls[0]?.[0];
    expect(capturedRequestContext).toBeInstanceOf(RequestContext);
    expect(getLocalAgentsArgs?.requestContext).toBe(capturedRequestContext);
    expect(getLocalAgentsArgs?.resourceId).toBe('user-123');

    getLocalAgentsSpy.mockRestore();
  });

  test('reuses the existing route RequestContext for setContext and agent factories', async () => {
    const aguiAgents: Record<string, AbstractAgent> = {};
    const existingRequestContext = new RequestContext();
    const getLocalAgentsSpy = spyOn(MastraAgentAdapter, 'getLocalAgents').mockReturnValue(aguiAgents);
    let capturedRequestContext: RequestContext<unknown> | undefined;

    const route = registerCopilotKit({
      path: '/copilotkit',
      resourceId: 'user-456',
      setContext: (_context, requestContext) => {
        capturedRequestContext = requestContext;
      },
    }) as unknown as RegisteredRoute;

    const routeContext = createRouteContext({
      mastra: { listAgents: () => ({}) },
      request: existingRequestContext,
    });

    await route.options.handler(routeContext);

    const getLocalAgentsArgs = getLocalAgentsSpy.mock.calls[0]?.[0];
    expect(capturedRequestContext).toBe(existingRequestContext);
    expect(getLocalAgentsArgs?.requestContext).toBe(existingRequestContext);

    getLocalAgentsSpy.mockRestore();
  });
});
