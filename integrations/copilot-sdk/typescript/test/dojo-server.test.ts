import { once } from "node:events";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { CopilotAdapter, type CopilotClientPort } from "../dist/index.js";
import { createDojoServer, fixtureClient, serverSettings } from "../examples/server.js";

it("defaults to native mode on loopback and honors explicit HOST/PORT overrides", () => {
  expect(serverSettings({})).toEqual({ mode: "live", host: "127.0.0.1", port: 8028, model: "gpt-5.4-mini" });
  expect(serverSettings({ HOST: "0.0.0.0", PORT: "8130", COPILOT_DEMO_MODE: "fixture", COPILOT_MODEL: "claude-sonnet-5" }))
    .toEqual({ mode: "fixture", host: "0.0.0.0", port: 8130, model: "claude-sonnet-5" });
  expect(serverSettings({ HOST: "::1" }).host).toBe("::1");
});

it.each([
  { PORT: "0" }, { PORT: "65536" }, { PORT: "NaN" }, { PORT: "1.5" },
  { HOST: "https://example.org" }, { COPILOT_DEMO_MODE: "unlabelled-mock" }, { COPILOT_MODEL: "" },
])("rejects invalid server configuration %j", (env) => {
  expect(() => serverSettings(env)).toThrow();
});

it("exposes an explicitly synthetic Dojo fixture with valid streaming and HTTP errors", async () => {
  const host = createDojoServer(new CopilotAdapter({ client: fixtureClient }), "fixture");
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  const url = `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`;
  const post = (path: string, value: unknown) => fetch(`${url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
  });
  try {
    expect(await (await fetch(`${url}/health`)).json()).toMatchObject({ mode: "fixture", synthetic: true });
    const response = await post("/agent", {
      threadId: "dojo", runId: "run", state: {}, context: [],
      tools: [{
        name: "change_background", description: "Change the chat background only when requested.",
        parameters: { type: "object", properties: { background: { type: "string" } }, required: ["background"] },
      }],
      forwardedProps: {},
      messages: [{ id: "u", role: "user", content: "Say hello in one sentence." }],
    });
    expect(response.status).toBe(200);
    const events = (await response.text()).split("\n\n").filter(Boolean)
      .map((line) => JSON.parse(line.slice("data: ".length)));
    expect(events[0].type).toBe("RUN_STARTED");
    expect(events.at(-1).type).toBe("RUN_FINISHED");
    expect(events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta).join("")).toBe("A synthetic Copilot SDK fixture says hello.");
    expect((await post("/agent", {})).status).toBe(400);
    expect((await fetch(`${url}/health`, { headers: { Origin: "https://untrusted.example" } })).status).toBe(403);
    expect(await new Promise((resolve, reject) => {
      get(`${url}/health`, { headers: { Host: "untrusted.example" } }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      }).once("error", reject);
    })).toBe(403);
    expect((await fetch(`${url}/health`, { headers: { Origin: "http://localhost:3100" } })).status).toBe(200);
    expect((await post("/agent", { tools: [{ name: "bash", description: "No", parameters: {} }],
      threadId: "unsafe", runId: "unsafe", state: {}, context: [], forwardedProps: {}, messages: [],
    })).status).toBe(403);
    expect((await post("/agent", { content: "x".repeat(1024 * 1024) })).status).toBe(413);
    expect((await fetch(`${url}/agent`, { method: "POST", body: "{}" })).status).toBe(415);
    expect(await (await post("/agent/cancel", { threadId: "missing" })).json()).toEqual({ cancelled: false });
    expect(await (await post("/cancel", { threadId: "missing" })).json()).toEqual({ cancelled: false });
    expect((await post("/agent/cancel", { threadId: "dojo", sessionId: "not-accepted" })).status).toBe(400);
  } finally { await host.close(); }
});

it("accepts declaration-only frontend answers over a second HTTP request without another native send", async () => {
  const envelope = () => ({ id: randomUUID(), timestamp: new Date().toISOString(), parentId: null });
  const send = vi.fn();
  const reply = vi.fn();
  const disconnect = vi.fn();
  const client: CopilotClientPort = {
    async createSession(config) {
      expect(config.tools).toEqual([{
        name: "browser_nonce", description: "Browser nonce", parameters: { type: "object", properties: {} },
      }]);
      expect(config.availableTools).toEqual(["browser_nonce"]);
      return {
        sessionId: "native-session",
        send: send.mockImplementation(async () => {
          config.onEvent?.({ ...envelope(), type: "assistant.message", data: {
            messageId: "m1", content: "", toolRequests: [{ toolCallId: "call1", name: "browser_nonce", arguments: {} }],
          } });
          config.onEvent?.({ ...envelope(), type: "external_tool.requested", data: {
            requestId: "server-owned", sessionId: "native-session", toolCallId: "call1", toolName: "browser_nonce", arguments: {},
          } });
          return "m1";
        }),
        async abort() {},
        disconnect,
        rpc: { tools: { handlePendingToolCall: reply.mockImplementation(async ({ result }) => {
          config.onEvent?.({ ...envelope(), type: "tool.execution_complete", data: {
            toolCallId: "call1", success: true, result: { content: result },
          } });
          config.onEvent?.({ ...envelope(), type: "assistant.message", data: { messageId: "m2", content: result } });
          config.onEvent?.({ ...envelope(), ephemeral: true, type: "session.idle", data: {} });
          return { success: true };
        }) } },
      };
    },
  };
  const host = createDojoServer(new CopilotAdapter({ client, runTimeoutMs: 1000 }), "live");
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  const url = `http://127.0.0.1:${(host.server.address() as AddressInfo).port}/agent`;
  const input = {
    threadId: "frontend", runId: "first", state: {}, context: [], forwardedProps: {},
    tools: [{ name: "browser_nonce", description: "Browser nonce", parameters: { type: "object", properties: {} } }],
    messages: [{ id: "user", role: "user", content: "Call browser_nonce" }],
  };
  const post = async (body: unknown) => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    return (await response.text()).split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.slice(6)));
  };
  try {
    const first = await post(input);
    expect(first.at(-1).type).toBe("RUN_FINISHED");
    expect(first.some((event) => event.type === "TOOL_CALL_END")).toBe(true);
    expect(first.some((event) => event.type === "TOOL_CALL_RESULT")).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
    const nonce = randomUUID();
    const resumedInput = { ...input, runId: "second", messages: [
      ...input.messages,
      { id: "assistant", role: "assistant", content: "", toolCalls: [
        { id: "call1", type: "function", function: { name: "browser_nonce", arguments: "{}" } },
      ] },
      { id: "answer", role: "tool", toolCallId: "call1", content: nonce },
    ] };
    const second = await post(resumedInput);
    expect(second.at(-1).type).toBe("RUN_FINISHED");
    expect(second.some((event) => event.type === "TEXT_MESSAGE_CONTENT" && event.delta === nonce)).toBe(true);
    expect(second.some((event) => event.type === "TOOL_CALL_RESULT")).toBe(false);
    const replay = await post({ ...resumedInput, runId: "third" });
    expect(replay.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledExactlyOnceWith({ requestId: "server-owned", result: nonce });
  } finally { await host.close(); }
  expect(disconnect).toHaveBeenCalledTimes(1);
});
