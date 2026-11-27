import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getServerHash, MCPClientConfig } from "../src/index";

// The hash goes to the client in ACTIVITY_SNAPSHOT events, is stored in
// thread history, and comes back in __proxiedMCPRequest.serverHash. The
// edge-safe MD5 must match the node:crypto output it replaced, or stored
// threads can no longer find their server.
const nodeServerHash = (config: MCPClientConfig) =>
  createHash("md5")
    .update(JSON.stringify({ type: config.type, url: config.url }))
    .digest("hex");

describe("getServerHash", () => {
  it.each<{ name: string; config: MCPClientConfig }>([
    { name: "empty URL", config: { type: "http", url: "" } },
    {
      name: "HTTP",
      config: { type: "http", url: "http://localhost:3000/mcp" },
    },
    { name: "SSE", config: { type: "sse", url: "https://example.com/sse" } },
    {
      name: "query and fragment",
      config: { type: "http", url: "https://example.com/mcp?a=1&b=two#x" },
    },
    {
      name: "IDN",
      config: { type: "http", url: "https://bücher.example/mcp" },
    },
    {
      name: "CJK path",
      config: { type: "http", url: "https://example.com/服务器/mcp" },
    },
    { name: "emoji", config: { type: "sse", url: "https://example.com/😀👍🏽" } },
    {
      name: "lone surrogate",
      config: { type: "http", url: "https://e/\ud800" },
    },
    {
      name: "control characters",
      config: { type: "http", url: 'https://e/\u0000\t\n"\\' },
    },
    {
      name: "long",
      config: { type: "http", url: `https://e/${"x".repeat(100_000)}` },
    },
  ])("matches node:crypto MD5 for $name", ({ config }) => {
    expect(getServerHash(config)).toBe(nodeServerHash(config));
  });

  it("keeps the published hash values", () => {
    expect(
      getServerHash({ type: "http", url: "http://localhost:3000/mcp" }),
    ).toBe("cf46be9fde11f8651c692c950328c190");
    expect(getServerHash({ type: "sse", url: "https://example.com/sse" })).toBe(
      "defc397035afd3c82a34b6eca87fa8cf",
    );
  });
});
