import http from "node:http";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { AGUI_MEDIA_TYPE, EventEncoder } from "@ag-ui/encoder";
import { Observable, of } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenAIAgentsAdapter } from "../src";
import { createServer } from "./server";

const runStarted: BaseEvent = {
  type: EventType.RUN_STARTED,
  threadId: "thread-1",
  runId: "run-1",
};

const servers: http.Server[] = [];

async function startServer(adapter: OpenAIAgentsAdapter): Promise<number> {
  const server = createServer({ test: adapter });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an address for the test server");
  }
  return address.port;
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 2_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function post(
  port: number,
  body: unknown,
  accept?: string,
): Promise<{ statusCode: number; contentType: string | undefined; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/test",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accept ? { Accept: accept } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            contentType: response.headers["content-type"],
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(typeof body === "string" ? body : JSON.stringify(body));
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(stopServer));
});

describe("example server", () => {
  it.each([
    ["null body", null],
    ["missing required fields", { messages: [] }],
    ["malformed messages", { threadId: "thread-1", runId: "run-1", messages: [null] }],
  ])("rejects a %s with 400 before running the adapter", async (_label, body) => {
    const run = vi.fn(() => of(runStarted));
    const port = await startServer({ run } as unknown as OpenAIAgentsAdapter);

    const response = await post(port, body);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body.toString("utf8"))).toEqual({
      error: "Invalid RunAgentInput",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("writes SSE frames when SSE is negotiated", async () => {
    const run = vi.fn(() => of(runStarted));
    const port = await startServer({ run } as unknown as OpenAIAgentsAdapter);

    const response = await post(port, {
      threadId: "thread-1",
      runId: "run-1",
      messages: [],
    });

    expect(response.statusCode).toBe(200);
    expect(response.contentType).toBe("text/event-stream");
    expect(response.body.toString("utf8")).toContain(
      'data: {"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}',
    );
  });

  it("writes protobuf frames when protobuf is negotiated", async () => {
    const run = vi.fn(() => of(runStarted));
    const port = await startServer({ run } as unknown as OpenAIAgentsAdapter);

    const response = await post(
      port,
      { threadId: "thread-1", runId: "run-1", messages: [] },
      AGUI_MEDIA_TYPE,
    );

    expect(response.statusCode).toBe(200);
    expect(response.contentType).toBe(AGUI_MEDIA_TYPE);
    expect(response.body).toEqual(
      Buffer.from(new EventEncoder({ accept: AGUI_MEDIA_TYPE }).encodeBinary(runStarted)),
    );
  });

  it("unsubscribes from the adapter stream when the client disconnects", async () => {
    let markUnsubscribed!: () => void;
    const unsubscribed = new Promise<void>((resolve) => {
      markUnsubscribed = resolve;
    });
    const stream = new Observable<BaseEvent>((subscriber) => {
      subscriber.next(runStarted);
      return markUnsubscribed;
    });
    const run = vi.fn((_input: RunAgentInput) => stream);
    const port = await startServer({ run } as unknown as OpenAIAgentsAdapter);

    await withTimeout(
      new Promise<void>((resolve) => {
        const request = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/test",
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (response) => {
            response.once("data", () => response.destroy());
            response.once("close", resolve);
            response.once("error", () => {});
          },
        );
        request.once("error", () => {});
        request.end(
          JSON.stringify({
            threadId: "thread-1",
            runId: "run-1",
            messages: [],
          }),
        );
      }),
      "Client response did not close",
    );

    await withTimeout(unsubscribed, "Adapter subscription was not cancelled");
  });
});
