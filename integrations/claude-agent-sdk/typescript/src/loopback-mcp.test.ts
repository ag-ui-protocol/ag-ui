import { request } from "node:http";
import { expect, it } from "vitest";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { startLoopbackMcp } from "./loopback-mcp";
it("rejects missing, malformed, and wrong-host credentials, then closes idempotently", async () => {
  const endpoint = await startLoopbackMcp(
    createSdkMcpServer({ name: "test", tools: [] }),
  );
  try {
    for (const headers of [
      {},
      { Authorization: "é".repeat(71) },
      { ...endpoint.config.headers, Host: "attacker.invalid" },
    ]) {
      const status = await new Promise<number | undefined>(
        (resolve, reject) => {
          const req = request(endpoint.config.url, { headers }, (res) => {
            res.resume();
            resolve(res.statusCode);
          });
          req.on("error", reject);
          req.end();
        },
      );
      expect(status).toBe(403);
    }
    expect(
      (
        await fetch(endpoint.config.url + "/wrong", {
          headers: endpoint.config.headers,
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(endpoint.config.url, { headers: endpoint.config.headers }))
        .status,
    ).not.toBe(403);
  } finally {
    await endpoint.close();
    await endpoint.close();
  }
  await expect(fetch(endpoint.config.url)).rejects.toThrow();
});
