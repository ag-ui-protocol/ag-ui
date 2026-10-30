// A real installed Anthropic SDK in a fresh process. Only localhost is permitted.
import Anthropic from "@anthropic-ai/sdk";
const { ManagedAgentsAgent } = await import(
  process.env.AG_UI_STATE_AGENT_MODULE ?? "../src/agent.ts"
);
import { lastValueFrom, toArray } from "rxjs";
const config = JSON.parse(process.argv[2]);
if (new URL(config.baseURL).hostname !== "127.0.0.1")
  throw new Error("Local probe only");
const agent = new ManagedAgentsAgent({
  managedAgentId: "agent_probe",
  environmentId: "env_probe",
  client: new Anthropic({
    apiKey: "local-test",
    baseURL: config.baseURL,
    maxRetries: 0,
  }),
  ...(config.imported
    ? {
        resolveSession: () => ({
          sessionId: "sesn_probe",
          lastUserMessageId: "u1",
        }),
      }
    : {}),
});
const events = await lastValueFrom(
  agent
    .run({
      threadId: "thread_probe",
      runId: config.imported ? "run2" : "run1",
      messages: [
        {
          id: config.imported ? "u2" : "u1",
          role: "user",
          content: "Read shared state and update the board.",
        },
      ],
      state: config.imported
        ? null
        : { secret: "unique-state-only-692", obsolete: true },
      tools: [],
      context: [
        { description: "A2UI catalog", value: "FlightCard and Calculator" },
      ],
      forwardedProps: {},
    })
    .pipe(toArray()),
);
process.stdout.write(JSON.stringify(events));
