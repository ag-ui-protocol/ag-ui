import http from "http";
import { A2AAgent } from "../agent";
import { A2AClient } from "@a2a-js/sdk/client";
import type { AddressInfo } from "net";
import type { BaseEvent, Message } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";

const createMessage = (message: Partial<Message>): Message => message as Message;

jest.setTimeout(30000);

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

const startA2AServer = async (): Promise<TestServer> => {
  let server: http.Server;
  let baseUrl: string;

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    if (method === "GET" && url === "/.well-known/agent.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          url: `${baseUrl}/rpc`,
          capabilities: { streaming: true },
          name: "local-e2e-agent",
          description: "Local A2A test server",
        }),
      );
      return;
    }

    if (method === "POST" && url === "/rpc") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const bodyString = Buffer.concat(chunks).toString("utf-8") || "{}";
        const body = JSON.parse(bodyString) as { id?: number; method?: string; params?: any };
        const rpcId = body.id ?? 1;

        if (body.method === "message/send") {
          const { message } = body.params ?? {};
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpcId,
              result: {
                kind: "message",
                messageId: "e2e-send",
                role: "agent",
                parts: [{ kind: "text", text: `Echo: ${message?.parts?.[0]?.text ?? "ping"}` }],
                contextId: message?.contextId ?? "ctx-e2e",
                taskId: message?.taskId ?? "task-e2e",
              },
            }),
          );
          return;
        }

        if (body.method === "tasks/get") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpcId,
              result: {
                kind: "task",
                id: body.params?.id ?? "task-e2e",
                contextId: "ctx-e2e",
                status: { state: "working" },
                history: [
                  {
                    kind: "message",
                    messageId: "snapshot-1",
                    role: "agent",
                    parts: [{ kind: "text", text: "Snapshot hello" }],
                  },
                ],
                artifacts: [],
              },
            }),
          );
          return;
        }

        if (body.method === "message/stream" || body.method === "tasks/resubscribe") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            Connection: "keep-alive",
            "Cache-Control": "no-cache",
          });

          const sendEvent = (payload: unknown) => {
            res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpcId, result: payload })}\n\n`);
          };

          sendEvent({
            kind: "task",
            id: "task-e2e",
            contextId: "ctx-e2e",
            status: { state: "working" },
            history: [],
            artifacts: [],
          });

          if (body.method === "tasks/resubscribe") {
            sendEvent({
              kind: "status-update",
              contextId: "ctx-e2e",
              taskId: "task-e2e",
              final: false,
              status: {
                state: "working",
                message: {
                  kind: "message",
                  messageId: "status-e2e",
                  role: "agent",
                  parts: [{ kind: "text", text: "Resubscribe status" }],
                },
                timestamp: new Date().toISOString(),
              },
            });
          } else {
            sendEvent({
              kind: "message",
              messageId: "stream-1",
              role: "agent",
              parts: [{ kind: "text", text: "Stream hello" }],
              contextId: "ctx-e2e",
              taskId: "task-e2e",
            });
          }

          sendEvent({
            kind: "artifact-update",
            contextId: "ctx-e2e",
            taskId: "task-e2e",
            append: false,
            lastChunk: true,
            artifact: {
              artifactId: "artifact-e2e",
              parts: [{ kind: "data", data: { foo: "bar" } }],
            },
          });

        sendEvent({
          kind: "status-update",
          contextId: "ctx-e2e",
          taskId: "task-e2e",
          final: true,
          status: {
            state: "succeeded",
            timestamp: new Date().toISOString(),
            message: {
              kind: "message",
              messageId: "status-final",
              role: "agent",
              parts: [{ kind: "text", text: "Completed" }],
            },
          },
        });

          res.end();
          return;
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: "Method not found" } }));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  };

  server = http.createServer(handler);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        }),
      ),
  };
};

describe("A2A live e2e (local test server)", () => {
  let server: TestServer | undefined;
  const observedEvents: BaseEvent[] = [];

  beforeAll(async () => {
    server = await startA2AServer();
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
  });

  it("runs end-to-end against the local A2A server", async () => {
    if (!server) {
      throw new Error("Test server failed to start");
    }

    const client = new A2AClient(server.baseUrl);
    const agent = new A2AAgent({
      a2aClient: client,
      initialMessages: [
        createMessage({ id: "user-live-1", role: "user", content: "Hello from AG-UI e2e" }),
      ],
      initialState: { view: { tasks: {}, artifacts: {} } },
    });

    const result = await agent.runAgent(
      {
        forwardedProps: { a2a: { mode: "stream" } },
      },
      {
        onEvent: ({ event }) => {
          observedEvents.push(event);
        },
      },
    );

    expect(result.newMessages.some((message) => message.role === "assistant")).toBe(true);

    const hasText =
      observedEvents.some(
        (event) =>
          (event.type === EventType.TEXT_MESSAGE_CONTENT ||
            event.type === EventType.TEXT_MESSAGE_CHUNK) &&
          "delta" in event &&
          typeof (event as { delta?: unknown }).delta === "string",
      ) ||
      result.newMessages.some((message) => typeof message.content === "string");
    expect(hasText).toBe(true);

    expect(
      (agent.state as { view?: { artifacts?: Record<string, unknown> } }).view?.artifacts?.[
        "artifact-e2e"
      ],
    ).toEqual({ foo: "bar" });
  });
});
