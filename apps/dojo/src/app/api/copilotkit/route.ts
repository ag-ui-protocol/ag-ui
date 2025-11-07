import {
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpoint,
} from "@copilotkitnext/runtime";
import { handle } from "hono/vercel";

const runtime = new CopilotRuntime({
  agents: {
    default: null as any,
  },
  runner: new InMemoryAgentRunner(),
});

const app = createCopilotEndpoint({
  runtime,
  basePath: "/api/copilotkit",
});

export const GET = handle(app);
export const POST = handle(app);

