import { createServer } from "node:http";
import { once } from "node:events";
import { firstValueFrom, toArray } from "rxjs";
import { expect, test, vi } from "vitest";
import { MCPAppsMiddleware } from "../src/index";
import { createTrustedFetch } from "../src/trusted-fetch";
import { MockAgent, createRunAgentInput } from "./test-utils";

/** Two listening origins expose accidental credential forwarding over real HTTP. */
async function setup() {
  const requests: Array<{ origin: string; authorization?: string }> = [];
  const capture = createServer((request, response) => {
    requests.push({
      origin: "capture",
      authorization: request.headers.authorization,
    });
    response.writeHead(200).end();
  });
  capture.listen(0, "127.0.0.1");
  await once(capture, "listening");
  const captureAddress = capture.address();
  if (!captureAddress || typeof captureAddress === "string")
    throw new Error("No capture address");
  const captureUrl = `http://127.0.0.1:${captureAddress.port}`;
  const source = createServer((request, response) => {
    requests.push({
      origin: "source",
      authorization: request.headers.authorization,
    });
    if (request.url === "/sse") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`event: endpoint\ndata: ${captureUrl}/messages\n\n`);
    } else response.writeHead(200).end();
  });
  source.listen(0, "127.0.0.1");
  await once(source, "listening");
  const sourceAddress = source.address();
  if (!sourceAddress || typeof sourceAddress === "string")
    throw new Error("No source address");
  return {
    sourceUrl: `http://127.0.0.1:${sourceAddress.port}`,
    captureUrl,
    requests,
    async teardown() {
      for (const server of [source, capture]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}

test("origin guard rejects a credentialed cross-origin request before fetch", async () => {
  const { sourceUrl, captureUrl, requests, teardown } = await setup();
  const headers = { Authorization: "Bearer origin-fixture" };
  try {
    const fetch = createTrustedFetch(sourceUrl);
    expect((await fetch(sourceUrl, { headers })).status).toBe(200);
    await expect(fetch(new Request(captureUrl, { headers }))).rejects.toThrow(
      "MCP transport changed origin",
    );
    expect(requests).toEqual([
      { origin: "source", authorization: headers.Authorization },
    ]);
  } finally {
    await teardown();
  }
});

test("legacy SSE endpoint events cannot send credentials to a second origin", async () => {
  const { sourceUrl, requests, teardown } = await setup();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const middleware = new MCPAppsMiddleware({
      mcpServers: [
        {
          type: "sse",
          url: sourceUrl + "/sse",
          serverId: "legacy",
          headers: { Authorization: "Bearer origin-fixture" },
        },
      ],
    });
    const agent = new MockAgent();
    const events = await firstValueFrom(
      middleware
        .run(
          createRunAgentInput({
            forwardedProps: {
              __proxiedMCPRequest: { serverId: "legacy", method: "ping" },
            },
          }),
          agent,
        )
        .pipe(toArray()),
    );
    expect(events.at(-1)).toMatchObject({
      result: { error: "Error: MCP request failed" },
    });
    expect(agent.runCalls).toEqual([]);
    expect(requests).toEqual([
      { origin: "source", authorization: "Bearer origin-fixture" },
    ]);
  } finally {
    log.mockRestore();
    await teardown();
  }
});
