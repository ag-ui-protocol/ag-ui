import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
  McpHttpServerConfig,
  McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";

/** One authenticated loopback MCP endpoint owned by one SDK query. */
export async function startLoopbackMcp(
  server: McpSdkServerConfigWithInstance,
): Promise<{
  config: McpHttpServerConfig;
  close(): Promise<void>;
}> {
  const secret = `Bearer ${randomBytes(32).toString("hex")}`;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
  });
  const sockets = new Set<import("node:net").Socket>();
  let http: HttpServer | undefined;
  let host: string;
  try {
    await server.instance.connect(transport);
    http = createServer((request, response) => {
      const authorization = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(secret);
      const authorized =
        authorization.length === expected.length &&
        timingSafeEqual(authorization, expected);
      if (
        request.headers.host !== host ||
        request.url !== "/mcp" ||
        !authorized
      ) {
        response.writeHead(403).end();
        return;
      }
      void transport.handleRequest(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    http.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      http!.once("error", reject);
      http!.listen(0, "127.0.0.1", () => {
        http!.off("error", reject);
        resolve();
      });
    });
    const address = http.address();
    if (!address || typeof address === "string")
      throw new Error("Could not bind the SDK tool endpoint.");
    host = `127.0.0.1:${address.port}`;
    let closing: Promise<void> | undefined;
    return {
      config: {
        type: "http",
        url: `http://${host}/mcp`,
        headers: { Authorization: secret },
        alwaysLoad: true,
      },
      close() {
        return (closing ??= (async () => {
          const closed = new Promise<void>((resolve, reject) =>
            http!.close((error) => (error ? reject(error) : resolve())),
          );
          for (const socket of sockets) socket.destroy();
          const results = await Promise.allSettled([
            closed,
            server.instance.close(),
          ]);
          for (const result of results)
            if (result.status === "rejected") throw result.reason;
        })());
      },
    };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    http?.close();
    await server.instance.close();
    throw error;
  }
}
