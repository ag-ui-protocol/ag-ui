import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { it } from "node:test";
import { lastValueFrom, toArray } from "rxjs";
import { EventType, type RunAgentInput } from "@ag-ui/client";
import {
  ManagedAgentsAgent,
  InMemorySessionStore,
  type SessionRecord,
  type ManagedAgentsAgentConfig,
} from "@ag-ui/claude-managed-agents";
import { registerManagedAgentsFake } from "./managed-agents-fake";
class RecordingSessionStore extends InMemorySessionStore {
  readonly writes: { record: SessionRecord }[] = [];
  override set(key: string, record: SessionRecord) {
    super.set(key, record);
    this.writes.push({ record: structuredClone(record) });
  }
}

// Resolve the SDK from its owning integration, avoiding an undeclared Dojo dependency.
type Anthropic = NonNullable<ManagedAgentsAgentConfig["client"]>;
const integrationRequire = createRequire(
  createRequire(import.meta.url).resolve("@ag-ui/claude-managed-agents"),
);
const { default: Anthropic } = integrationRequire("@anthropic-ai/sdk") as {
  default: new (options: { apiKey: string; baseURL: string }) => Anthropic;
};

async function withFake(run: (client: Anthropic) => Promise<void>) {
  const handlers = new Map<
    string,
    Parameters<typeof registerManagedAgentsFake>[0] extends {
      mount(path: string, handler: infer H): unknown;
    }
      ? H
      : never
  >();
  registerManagedAgentsFake({
    mount: (path, handler) => handlers.set(path, handler),
  });
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    for (const [prefix, handler] of handlers) {
      if (
        pathname.startsWith(prefix) &&
        (await handler.handleRequest(req, res, pathname.slice(prefix.length)))
      )
        return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP address");
  const client = new Anthropic({
    apiKey: "fake",
    baseURL: `http://127.0.0.1:${address.port}`,
  });
  try {
    await run(client);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const inputFor = (content: string): RunAgentInput => ({
  threadId: "dojo-history",
  runId: "first",
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
  messages: [{ id: "u1", role: "user", content }],
});

it("continues a Dojo session through the real SDK history endpoint", async () => {
  await withFake(async (client) => {
    const agent = new ManagedAgentsAgent({
      managedAgentId: "agent_fake_agentic_chat",
      environmentId: "env_fake",
      client,
    });
    const input = inputFor("Hi, my name is Alex");
    await lastValueFrom(agent.run(input).pipe(toArray()));
    const events = await lastValueFrom(
      agent
        .run({
          ...input,
          runId: "second",
          messages: [
            ...input.messages,
            { id: "u2", role: "user", content: "What is my name?" },
          ],
        })
        .pipe(toArray()),
    );
    assert.deepEqual(
      events.filter((e) => e.type === EventType.RUN_ERROR),
      [],
    );
    assert.equal(
      events
        .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((e) => ("delta" in e ? e.delta : ""))
        .join(""),
      "Your name is Alex.",
    );
  });
});

it("recovers a pending Dojo tool after restart and records the real result", async () => {
  await withFake(async (client) => {
    const store = new RecordingSessionStore();
    const config = {
      managedAgentId: "agent_fake_backend_tool_rendering",
      environmentId: "env_fake",
      client,
      sessionStore: store,
    };
    const input = inputFor("What is the weather in Paris?");
    input.tools = [
      {
        name: "get_weather",
        description: "Weather",
        parameters: {
          type: "object",
          properties: { location: { type: "string" } },
        },
      },
    ];
    const first = await lastValueFrom(
      new ManagedAgentsAgent(config).run(input).pipe(toArray()),
    );
    assert.deepEqual(
      first.filter((e) => e.type === EventType.RUN_ERROR),
      [],
    );
    const record = store.writes.at(-1)?.record;
    assert.ok(record);
    assert.equal(record.pendingClientToolUseIds.length, 1);
    const callId = record.pendingClientToolUseIds[0];
    const resumed = await lastValueFrom(
      new ManagedAgentsAgent(config)
        .run({
          ...input,
          runId: "second",
          messages: [
            ...input.messages,
            {
              id: "result",
              role: "tool",
              toolCallId: callId,
              content: "Sunny, 22 C",
            },
          ],
        })
        .pipe(toArray()),
    );
    assert.deepEqual(
      resumed.filter((e) => e.type === EventType.RUN_ERROR),
      [],
    );
    assert.equal(resumed.at(-1)?.type, EventType.RUN_FINISHED);
    assert.deepEqual(store.writes.at(-1)?.record.pendingClientToolUseIds, []);
    const history = await client.beta.sessions.events.list(record.sessionId);
    assert.ok(
      history.data.some(
        (e) => e.type === "agent.custom_tool_use" && e.id === callId,
      ),
    );
    const result = history.data.find(
      (e) =>
        e.type === "user.custom_tool_result" && e.custom_tool_use_id === callId,
    );
    assert.ok(result && result.type === "user.custom_tool_result");
    assert.deepEqual(result.content, [{ type: "text", text: "Sunny, 22 C" }]);
    assert.equal(result.is_error, false);
  });
});

it("auto-paginates Dojo history through the SDK without dropping or repeating IDs", async () => {
  await withFake(async (client) => {
    const session = await client.beta.sessions.create({
      agent: "agent_fake_agentic_chat",
      environment_id: "env_fake",
    });
    const sent = await client.beta.sessions.events.send(session.id, {
      events: Array.from({ length: 7 }, (_, index) => ({
        type: "user.message" as const,
        content: [{ type: "text" as const, text: "Message " + index }],
      })),
    });
    const history = [];
    for await (const event of client.beta.sessions.events.list(session.id, {
      limit: 2,
    }))
      history.push(event);
    assert.ok(sent.data);
    assert.deepEqual(
      history.slice(0, 7).map((e) => e.id),
      sent.data.map((e) => e.id),
    );
    assert.equal(new Set(history.map((e) => e.id)).size, history.length);
    assert.ok(history.length >= 7);
  });
});
