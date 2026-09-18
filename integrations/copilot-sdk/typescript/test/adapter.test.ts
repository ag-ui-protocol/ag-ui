import { describe, expect, it, vi } from "vitest";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { verifyEvents } from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import type { SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { CopilotAdapter, CopilotAgent, type CopilotAdapterOptions, type CopilotSessionPort, type ToolContext } from "../src/adapter.js";

let sequence = 0;
function event(type: SessionEvent["type"] | "agent.interrupted", data: Record<string, unknown>): SessionEvent {
  return { type, data, id: `e${++sequence}`, timestamp: "2026-09-16T00:00:00Z", parentId: null } as SessionEvent;
}
function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return { threadId: "thread", runId: `run${++sequence}`, messages: [{ id: "user1", role: "user", content: "hello" }],
    tools: [], context: [], state: {}, forwardedProps: {}, ...overrides };
}
function fake(options: Partial<CopilotAdapterOptions> = {}) {
  const sessions: (CopilotSessionPort & { emit: (e: SessionEvent) => void; config: SessionConfig })[] = [];
  let action: (session: typeof sessions[number]) => void = (session) => {
    session.emit(event("assistant.message", { messageId: "m", content: "hello" }));
    session.emit(event("session.idle", {}));
  };
  const client = {
    createSession: vi.fn(async (config: SessionConfig) => {
      const session: typeof sessions[number] = {
        sessionId: `session${sessions.length}`, config,
        emit: (e) => config.onEvent?.(e),
        send: vi.fn(async () => { action(session); return "message"; }),
        abort: vi.fn(async () => {}),
        disconnect: vi.fn(async () => {}),
        rpc: { tools: { handlePendingToolCall: vi.fn(async () => ({ success: true })) } },
      };
      sessions.push(session);
      config.onEvent?.(event("assistant.message_delta", { messageId: "early", deltaContent: "early" }));
      return session;
    }),
  };
  return { adapter: new CopilotAdapter({ client, runTimeoutMs: 1000, ...options }), sessions, client, action: (fn: typeof action) => { action = fn; } };
}
async function collect(stream: AsyncIterable<BaseEvent>) { const events: BaseEvent[] = []; for await (const e of stream) events.push(e); return events; }
const frontend = [{ name: "browser_tool", description: "Browser", parameters: { type: "object" } }];
function request(id: string) {
  return event("external_tool.requested", { toolCallId: id, requestId: `private-${id}`, toolName: "browser_tool", sessionId: "session0", arguments: {} });
}
async function pending(count = 2) {
  const f = fake();
  f.action((session) => {
    session.emit(event("assistant.message", { messageId: "calls", content: "", toolRequests:
      Array.from({ length: count }, (_, i) => ({ toolCallId: `c${i}`, name: "browser_tool", arguments: {} })) }));
    for (let i = 0; i < count; i++) session.emit(request(`c${i}`));
  });
  const trace = await collect(f.adapter.stream(input({ tools: frontend })));
  return { ...f, trace };
}
function result(id: string, content = `value-${id}`) { return { id: `result-${id}`, role: "tool" as const, toolCallId: id, content }; }

describe("owned native sessions and browser continuation", () => {
  it("keeps the adapter when AbstractAgent consumers clone the agent", async () => {
    const f = fake();
    const agent = new CopilotAgent(f.adapter, { threadId: "thread" });
    const clone = agent.clone();
    expect(clone.adapter).toBe(f.adapter);
    expect(clone.messages).not.toBe(agent.messages);
    await f.adapter.close();
  });
  it("captures early create events; a fresh turn sends only the latest user message", async () => {
    const f = fake();
    const trace = await collect(f.adapter.stream(input()));
    expect(trace[0]?.type).toBe("RUN_STARTED");
    expect(f.sessions[0]?.config.model).toBe("gpt-5.4-mini");
    expect(trace.some((e) => e.delta === "early")).toBe(true);
    await collect(f.adapter.stream(input({ messages: [{ id: "old", role: "user", content: "old" }, { id: "user2", role: "user", content: "new" }] })));
    expect(f.client.createSession).toHaveBeenCalledTimes(1);
    expect(f.sessions[0]?.send).toHaveBeenLastCalledWith({ prompt: "new" });
    await f.adapter.close();
    expect(f.sessions[0]?.disconnect).toHaveBeenCalled();
  });

  it.each(["abort", "agent.interrupted"] as const)("disposes native %s sessions despite a subsequent idle event", async (type) => {
    const f = fake();
    f.action((session) => {
      session.emit(event("tool.execution_start", { toolCallId: "call", toolName: "backend", arguments: {} }));
      session.emit(event(type, {}));
      session.emit(event("session.idle", {}));
    });
    const trace = await collect(f.adapter.stream(input()));
    expect(trace.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "CANCELLED" });
    expect(trace.some((event) => event.type === "TOOL_CALL_RESULT" || event.type === "RUN_FINISHED")).toBe(false);
    expect(f.sessions[0]?.disconnect).toHaveBeenCalledExactlyOnceWith();
    f.action((session) => session.emit(event("session.idle", {})));
    await collect(f.adapter.stream(input({ messages: [{ id: "user2", role: "user", content: "new turn" }] })));
    expect(f.client.createSession).toHaveBeenCalledTimes(2);
    await f.adapter.close();
  });

  it.each(["complete", "cancel"] as const)("preserves app output provenance through %s without suppressing SDK results", async (outcome) => {
    let context: ToolContext;
    const controller = new AbortController();
    const f = fake({ tools: (value) => {
      context = value;
      return [{ name: "app_tool", handler: () => "actual result" }];
    } });
    f.action((session) => {
      session.emit(event("tool.execution_start", { toolCallId: "app", toolName: "app_tool", arguments: {} }));
      context.emitActivity("activity:app", "copilot-sdk:tool", {
        toolCallId: "app", toolName: "app_tool", status: "running",
        output: "application output", command: "fixture only", source: "application-fixture", truncated: false,
      });
      if (outcome === "cancel") controller.abort();
      else {
        session.emit(event("tool.execution_complete", { toolCallId: "app", success: true, result: { content: "actual result" } }));
        session.emit(event("session.idle", {}));
      }
    });
    const trace = await collect(f.adapter.stream(input(), { signal: controller.signal }));
    const lastActivity = trace.filter((event) => event.type === "ACTIVITY_SNAPSHOT").at(-1)?.content;
    expect(lastActivity).toMatchObject({
      source: "application-fixture", command: "fixture only",
      output: outcome === "cancel" ? "application output" : "actual result",
      status: outcome === "cancel" ? "cancelled" : "completed",
    });
    const results = trace.filter((event) => event.type === "TOOL_CALL_RESULT");
    expect(results).toHaveLength(outcome === "cancel" ? 0 : 1);
    if (outcome === "complete") expect(results[0]?.content).toBe("actual result");
    await lastValueFrom(from(trace).pipe(verifyEvents(), toArray()));
    await f.adapter.close();
  });

  it("hands off all frontend calls without fabricated results, resolves out of order with no send", async () => {
    const f = await pending();
    expect(f.trace.filter((e) => e.type === "TOOL_CALL_END")).toHaveLength(2);
    expect(f.trace.at(-1)?.type).toBe("RUN_FINISHED");
    expect(f.trace.some((e) => e.type === "TOOL_CALL_RESULT")).toBe(false);
    const session = f.sessions[0]!;
    let calls = 0;
    vi.mocked(session.rpc.tools.handlePendingToolCall).mockImplementation(async () => {
      if (++calls === 2) {
        session.emit(event("tool.execution_complete", { toolCallId: "c0", success: true, result: { content: "value-c0" } }));
        session.emit(event("tool.execution_complete", { toolCallId: "c1", success: true, result: { content: "value-c1" } }));
        session.emit(event("assistant.message", { messageId: "continued", content: "actual results" }));
        session.emit(event("session.idle", {}));
      }
      return { success: true };
    });
    const trace = await collect(f.adapter.stream(input({ tools: frontend, messages: [result("c1"), result("c0")] })));
    expect(session.send).toHaveBeenCalledTimes(1);
    expect(session.rpc.tools.handlePendingToolCall).toHaveBeenNthCalledWith(1, { requestId: "private-c1", result: "value-c1" });
    expect(session.rpc.tools.handlePendingToolCall).toHaveBeenNthCalledWith(2, { requestId: "private-c0", result: "value-c0" });
    expect(trace.filter((e) => e.type === "TOOL_CALL_RESULT")).toHaveLength(0);
    expect(trace.at(-1)?.type).toBe("RUN_FINISHED");
    const replay = await collect(f.adapter.stream(input({ tools: frontend, messages: [result("c1"), result("c0")] })));
    expect(replay.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
    expect(session.rpc.tools.handlePendingToolCall).toHaveBeenCalledTimes(2);
    expect(session.send).toHaveBeenCalledTimes(1);
    const conflict = await collect(f.adapter.stream(input({ tools: frontend, messages: [result("c0", "changed")] })));
    expect(conflict.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "FRONTEND_TOOL_RESULT_CONFLICT" });
    await f.adapter.close();
  });

  it.each([
    ["duplicate", [result("c0"), result("c0")], "thread"],
    ["wrong id", [result("c0"), result("evil")], "thread"],
    ["wrong thread", [result("c0"), result("c1")], "other"],
  ])("rejects %s results before native side effects", async (_, messages, threadId) => {
    const f = await pending();
    await expect(collect(f.adapter.stream(input({ tools: frontend, messages, threadId })))).rejects.toThrow();
    expect(f.sessions[0]?.rpc.tools.handlePendingToolCall).not.toHaveBeenCalled();
    await f.adapter.close();
  });

  it("buffers partial batches and submits original RPCs only once every answer is present", async () => {
    const f = await pending(2);
    const session = f.sessions[0]!;
    const partial = await collect(f.adapter.stream(input({ tools: frontend, messages: [result("c1")] })));
    expect(partial.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
    expect(session.rpc.tools.handlePendingToolCall).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    const replay = await collect(f.adapter.stream(input({ tools: frontend, messages: [result("c1")] })));
    expect(replay.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
    const changed = await collect(f.adapter.stream(input({ tools: frontend, messages: [result("c1", "changed")] })));
    expect(changed.at(-1)?.code).toBe("FRONTEND_TOOL_RESULT_CONFLICT");
    let calls = 0;
    vi.mocked(session.rpc.tools.handlePendingToolCall).mockImplementation(async () => {
      if (++calls === 2) {
        session.emit(event("tool.execution_complete", { toolCallId: "c0", success: true, result: { content: "value-c0" } }));
        session.emit(event("tool.execution_complete", { toolCallId: "c1", success: true, result: { content: "value-c1" } }));
        session.emit(event("session.idle", {}));
      }
      return { success: true };
    });
    const resumed = await collect(f.adapter.stream(input({ tools: frontend, messages: [result("c1"), result("c0")] })));
    expect(resumed.at(-1)?.type).toBe("RUN_FINISHED");
    expect(session.rpc.tools.handlePendingToolCall).toHaveBeenCalledTimes(2);
    expect(session.send).toHaveBeenCalledTimes(1);
    await f.adapter.close();
  });

  it("rejects new user turn while native tool results are missing", async () => {
    const f = await pending(1);
    await expect(collect(f.adapter.stream(input({ tools: frontend })))).rejects.toThrow("Missing");
    await f.adapter.close();
  });

  it.each(["", undefined])("rejects missing native request identity %s before handoff", async (requestId) => {
    const f = fake();
    f.action((session) => session.emit(event("external_tool.requested", {
      toolCallId: "call", requestId, toolName: "browser_tool", sessionId: "session0", arguments: {},
    })));
    const trace = await collect(f.adapter.stream(input({ tools: frontend })));
    expect(trace.at(-1)?.code).toBe("FRONTEND_TOOL_IDENTITY_ERROR");
    expect(f.sessions[0]?.rpc.tools.handlePendingToolCall).not.toHaveBeenCalled();
    await f.adapter.close();
  });

  it("rejects one native request ID assigned to two pending tool calls", async () => {
    const f = fake();
    f.action((session) => {
      session.emit(request("c0"));
      session.emit(event("external_tool.requested", {
        toolCallId: "c1", requestId: "private-c0", toolName: "browser_tool", sessionId: "session0", arguments: {},
      }));
    });
    const trace = await collect(f.adapter.stream(input({ tools: frontend })));
    expect(trace.at(-1)?.code).toBe("FRONTEND_TOOL_IDENTITY_ERROR");
    expect(f.sessions[0]?.rpc.tools.handlePendingToolCall).not.toHaveBeenCalled();
    await f.adapter.close();
  });

  it("retains native request ownership after an answer is resolved", async () => {
    const f = await pending(1);
    const session = f.sessions[0]!;
    vi.mocked(session.rpc.tools.handlePendingToolCall).mockImplementation(async () => {
      session.emit(event("tool.execution_complete", { toolCallId: "c0", success: true, result: { content: "value-c0" } }));
      session.emit(event("session.idle", {}));
      return { success: true };
    });
    await collect(f.adapter.stream(input({ tools: frontend, messages: [result("c0")] })));
    f.action((native) => native.emit(event("external_tool.requested", {
      toolCallId: "new-call", requestId: "private-c0", toolName: "browser_tool", sessionId: "session0", arguments: {},
    })));
    const trace = await collect(f.adapter.stream(input({
      tools: frontend, messages: [{ id: "user2", role: "user", content: "another call" }],
    })));
    expect(trace.at(-1)?.code).toBe("FRONTEND_TOOL_IDENTITY_ERROR");
    expect(session.rpc.tools.handlePendingToolCall).toHaveBeenCalledTimes(1);
    await f.adapter.close();
  });

  it("keeps frontend RPC pending until all parallel backend tools finish", async () => {
    const f = fake();
    f.action((s) => {
      s.emit(event("assistant.message", { messageId: "m", content: "", toolRequests: [
        { name: "browser_tool", toolCallId: "c0", arguments: {} }, { name: "backend", toolCallId: "backend", arguments: {} },
      ] }));
      s.emit(request("c0"));
      setTimeout(() => s.emit(event("tool.execution_complete", { toolCallId: "backend", success: true, result: { content: "real" } })), 10);
    });

    const trace = await collect(f.adapter.stream(input({ tools: frontend })));
    expect(trace.some((e) => e.type === "TOOL_CALL_RESULT" && e.content === "real")).toBe(true);
    expect(trace.at(-1)?.type).toBe("RUN_FINISHED");
    await f.adapter.close();
  });

  it("lets SDK handlers own external_tool.requested events for backend tools", async () => {
    const f = fake({ tools: () => [{ name: "backend", handler: () => "real" }] });
    f.action((s) => {
      s.emit(event("external_tool.requested", { toolCallId: "b", toolName: "backend", requestId: "native-backend", sessionId: s.sessionId, arguments: {} }));
      s.emit(event("tool.execution_complete", { toolCallId: "b", success: true, result: { content: "real" } }));
      s.emit(event("session.idle", {}));
    });
    const trace = await collect(f.adapter.stream(input()));
    expect(trace.at(-1)?.type).toBe("RUN_FINISHED");
    expect(f.sessions[0]?.rpc.tools.handlePendingToolCall).not.toHaveBeenCalled();
    expect(trace.some((e) => e.type === "TOOL_CALL_RESULT" && e.content === "real")).toBe(true);
    await f.adapter.close();
  });

  it("accepts full-history backend results alongside new browser results", async () => {
    const f = fake({ tools: () => [{ name: "backend", handler: () => "real" }] });
    f.action((s) => {
      s.emit(event("assistant.message", { messageId: "m", content: "", toolRequests: [
        { toolCallId: "b", name: "backend", arguments: {} }, { toolCallId: "c0", name: "browser_tool", arguments: {} },
      ] }));
      s.emit(event("tool.execution_complete", { toolCallId: "b", success: true, result: { content: "real" } }));
      s.emit(request("c0"));
    });
    await collect(f.adapter.stream(input({ tools: frontend })));
    const session = f.sessions[0]!;
    vi.mocked(session.rpc.tools.handlePendingToolCall).mockImplementation(async () => {
      session.emit(event("session.idle", {}));
      return { success: true };
    });
    const trace = await collect(f.adapter.stream(input({ tools: frontend, messages: [result("b", "real"), result("c0", "browser")] })));
    expect(session.rpc.tools.handlePendingToolCall).toHaveBeenCalledExactlyOnceWith({ requestId: "private-c0", result: "browser" });
    expect(trace.at(-1)?.type).toBe("RUN_FINISHED");
    await f.adapter.close();
  });

  it("locks a thread but permits independent sessions", async () => {
    const f = fake();
    f.action(() => {});
    const controller = new AbortController();
    const running = collect(f.adapter.stream(input(), { signal: controller.signal }));
    await new Promise((resolve) => setImmediate(resolve));
    await expect(collect(f.adapter.stream(input()))).rejects.toThrow("active");
    f.action((s) => s.emit(event("session.idle", {})));
    const independent = await collect(f.adapter.stream(input({ threadId: "other" })));
    expect(independent.at(-1)?.type).toBe("RUN_FINISHED");
    controller.abort();
    expect((await running).at(-1)).toMatchObject({ type: "RUN_ERROR", code: "CANCELLED" });
    expect(f.sessions[0]?.abort).toHaveBeenCalled();
    await f.adapter.close();
  });

  it("consumer disconnect and shutdown clean up sessions and listeners", async () => {
    const f = fake();
    f.action(() => {});
    const stream = f.adapter.stream(input());
    await stream.next();
    await stream.return();
    expect(f.sessions[0]?.disconnect).toHaveBeenCalled();
    await f.adapter.close();
    await expect(collect(f.adapter.stream(input()))).rejects.toThrow("closed");
  });

  it("timeout and native errors have exactly one terminal", async () => {
    const f = fake({ runTimeoutMs: 10 });
    f.action(() => {});
    const trace = await collect(f.adapter.stream(input()));
    expect(trace.filter((e) => e.type === "RUN_ERROR")).toHaveLength(1);
    expect(trace.some((e) => e.type === "RUN_FINISHED")).toBe(false);
    expect(f.sessions[0]?.disconnect).toHaveBeenCalled();
  });

  it("bounded producer queue fails closed and cleans up", async () => {
    const f = fake({ maxQueueEvents: 3 });
    f.action((s) => {
      for (let i = 0; i < 20; i++) s.emit(event("assistant.message_delta", { messageId: "m", deltaContent: "x" }));
    });
    const trace = await collect(f.adapter.stream(input()));
    expect(trace.at(-1)?.type).toBe("RUN_ERROR");
    expect(f.sessions[0]?.disconnect).toHaveBeenCalled();
  });

  it("bounds capacity, output and pending maps", async () => {
    const f = fake({ maxThreads: 1 });
    await collect(f.adapter.stream(input()));
    await expect(collect(f.adapter.stream(input({ threadId: "new" })))).rejects.toThrow("capacity");
    await f.adapter.close();
    const limited = fake({ maxOutputBytes: 2 });
    const trace = await collect(limited.adapter.stream(input()));
    expect(trace.at(-1)?.type).toBe("RUN_ERROR");
    await limited.adapter.close();
  });

  it("rejects malformed input and changed schemas without creating a session", async () => {
    const f = fake();
    await expect(collect(f.adapter.stream({} as RunAgentInput))).rejects.toThrow("RunAgentInput");
    expect(f.client.createSession).not.toHaveBeenCalled();
    await collect(f.adapter.stream(input()));
    await expect(collect(f.adapter.stream(input({ tools: frontend, messages: [{ id: "user2", role: "user", content: "again" }] })))).rejects.toThrow("definitions changed");
    await f.adapter.close();
  });

  it("state snapshots and transactional tool deltas are scoped to the owning thread", async () => {
    let context: Parameters<NonNullable<CopilotAdapterOptions["tools"]>>[0] | undefined;
    const f = fake({
      state: { initial: { version: 0 }, accept: (value, current) => value ?? current },
      tools: (value) => { context = value; return []; },
    });
    f.action((s) => {
      context!.setState({ version: 1 }, [{ op: "replace", path: "/version", value: 1 }]);
      s.emit(event("session.idle", {}));
    });
    const trace = await collect(f.adapter.stream(input({ state: { version: 0 } })));
    expect(trace[1]).toMatchObject({ type: "STATE_SNAPSHOT", snapshot: { version: 0 } });
    expect(trace.some((e) => e.type === "STATE_DELTA")).toBe(true);
    expect(() => context!.setState({}, [])).toThrow("No active");
    await f.adapter.close();
  });

  it("invalidates native sessions when the pending RPC rejects a result", async () => {
    const f = await pending(1);
    vi.mocked(f.sessions[0]!.rpc.tools.handlePendingToolCall).mockResolvedValue({ success: false });
    const trace = await collect(f.adapter.stream(input({ tools: frontend, messages: [result("c0")] })));
    expect(trace.at(-1)).toMatchObject({ type: "RUN_ERROR", message: "Native pending tool response was rejected" });
    expect(f.sessions[0]!.disconnect).toHaveBeenCalled();
    await expect(collect(f.adapter.stream(input({ tools: frontend, messages: [result("c0")] })))).rejects.toThrow("Stale");
  });

  it("closes an active stream during shutdown and ignores late events", async () => {
    const f = fake();
    f.action(() => {});
    const running = collect(f.adapter.stream(input()));
    await new Promise((resolve) => setImmediate(resolve));
    await f.adapter.close();
    const trace = await running;
    expect(trace.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "CANCELLED" });
    expect(() => f.sessions[0]!.emit(event("assistant.message", { messageId: "late", content: "ignored" }))).not.toThrow();
  });

  it("captures session creation failure and releases the reservation for a retry", async () => {
    const f = fake();
    f.client.createSession.mockRejectedValueOnce(new Error("native create failed"));
    const trace = await collect(f.adapter.stream(input()));
    expect(trace.at(-1)).toMatchObject({ type: "RUN_ERROR", message: "native create failed" });
    expect((await collect(f.adapter.stream(input()))).at(-1)?.type).toBe("RUN_FINISHED");
    await f.adapter.close();
  });

  it("retains per-thread locking while expired sessions are being disposed", async () => {
    const f = fake({ idleTimeoutMs: 1 });
    await collect(f.adapter.stream(input()));
    await new Promise((resolve) => setTimeout(resolve, 5));
    let release!: () => void;
    vi.mocked(f.sessions[0]!.abort).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const replacement = collect(f.adapter.stream(input({ messages: [{ id: "u2", role: "user", content: "new" }] })));
    await new Promise((resolve) => setImmediate(resolve));
    await expect(collect(f.adapter.stream(input()))).rejects.toThrow("active");
    release();
    expect((await replacement).at(-1)?.type).toBe("RUN_FINISHED");
    await f.adapter.close();
  });

  it("keeps original declarations while parked even if the continuation tool list changes", async () => {
    const f = await pending(1);
    const session = f.sessions[0]!;
    vi.mocked(session.rpc.tools.handlePendingToolCall).mockImplementation(async () => {
      session.emit(event("session.idle", {}));
      return { success: true };
    });
    expect((await collect(f.adapter.stream(input({ tools: [], messages: [result("c0")] })))).at(-1)?.type).toBe("RUN_FINISHED");
    expect(f.client.createSession).toHaveBeenCalledTimes(1);
    expect(session.config.tools?.some((tool) => tool.name === "browser_tool")).toBe(true);
    await f.adapter.close();
  });

  it("scans replayed results in full history alongside new user turns and later tool answers", async () => {
    const f = await pending(1);
    const session = f.sessions[0]!;
    vi.mocked(session.rpc.tools.handlePendingToolCall).mockImplementation(async (request) => {
      session.emit(event("tool.execution_complete", {
        toolCallId: request.requestId.replace("private-", ""), success: true, result: { content: String(request.result) },
      }));
      session.emit(event("session.idle", {}));
      return { success: true };
    });
    await collect(f.adapter.stream(input({ tools: frontend, messages: [result("c0")] })));
    f.action((s) => s.emit(request("c1")));
    const oldAnswer = result("c0");
    await collect(f.adapter.stream(input({
      tools: frontend,
      messages: [oldAnswer, { id: "u2", role: "user", content: "another browser tool" }],
    })));
    expect(session.send).toHaveBeenCalledTimes(2);
    await collect(f.adapter.stream(input({
      tools: frontend,
      messages: [oldAnswer, { id: "u2", role: "user", content: "another browser tool" }, result("c1")],
    })));
    expect(session.rpc.tools.handlePendingToolCall).toHaveBeenCalledTimes(2);
    expect(session.rpc.tools.handlePendingToolCall).toHaveBeenLastCalledWith({ requestId: "private-c1", result: "value-c1" });
    await f.adapter.close();
  });

  it("explicit Stop cancels parked sessions, while ordinary successful handoff does not", async () => {
    const f = await pending(1);
    expect(f.sessions[0]!.abort).not.toHaveBeenCalled();
    expect(f.sessions[0]!.disconnect).not.toHaveBeenCalled();
    expect(await f.adapter.cancelThread("thread")).toBe(true);
    expect(f.sessions[0]!.abort).toHaveBeenCalled();
    expect(f.sessions[0]!.disconnect).toHaveBeenCalled();
    expect(await f.adapter.cancelThread("thread")).toBe(false);
    await expect(collect(f.adapter.stream(input({ tools: frontend, messages: [result("c0")] })))).rejects.toThrow("Stale");
  });

  it("explicit Stop also cancels active work and disconnects exactly once", async () => {
    const f = fake();
    f.action(() => {});
    const running = collect(f.adapter.stream(input()));
    await new Promise((resolve) => setImmediate(resolve));
    expect(await f.adapter.cancelThread("thread")).toBe(true);
    expect((await running).at(-1)).toMatchObject({ type: "RUN_ERROR", code: "CANCELLED" });
    expect(f.sessions[0]!.disconnect).toHaveBeenCalledTimes(1);
    await f.adapter.close();
  });

  it.each(["", "   "])("rejects blank native frontend tool identity %j before emitting a bogus call", async (id) => {
    const f = fake();
    f.action((s) => s.emit(request(id)));
    const trace = await collect(f.adapter.stream(input({ tools: frontend })));
    expect(trace.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "FRONTEND_TOOL_IDENTITY_ERROR" });
    expect(trace.some((event) => event.type === "TOOL_CALL_START")).toBe(false);
  });

  it("parks a child frontend tool, re-announces the same child, and passes the pinned verifier", async () => {
    const f = fake();
    f.action((s) => {
      s.emit(event("tool.execution_start", { toolCallId: "spawn", toolName: "task", arguments: {} }));
      s.emit({ ...event("subagent.started", {
        toolCallId: "spawn", agentName: "child", agentDisplayName: "Child", agentDescription: "Browser interaction",
      }), agentId: "child-id" });
      s.emit({ ...event("tool.execution_start", { toolCallId: "c0", toolName: "browser_tool", arguments: {} }), agentId: "child-id" });
      s.emit({ ...request("c0"), agentId: "child-id" });
    });
    const first = await collect(f.adapter.stream(input({ tools: frontend })));
    expect(first.find((event) => event.type === "SUBAGENT_FINISHED")).toMatchObject({ subagentRunId: "child-id", outcome: { type: "suspended" } });
    expect(first.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
    expect(first.at(-1)?.outcome).toBeUndefined();
    expect(f.sessions[0]!.abort).not.toHaveBeenCalled();
    const session = f.sessions[0]!;
    vi.mocked(session.rpc.tools.handlePendingToolCall).mockImplementation(async () => {
      session.emit({ ...event("tool.execution_complete", { toolCallId: "c0", success: true, result: { content: "browser answer" } }), agentId: "child-id" });
      session.emit({ ...event("tool.execution_start", { toolCallId: "c0", toolName: "browser_tool", arguments: {} }), agentId: "child-id" });
      session.emit({ ...request("c0"), agentId: "child-id" });
      session.emit({ ...event("assistant.message", { messageId: "child-message", content: "Child consumed browser answer" }), agentId: "child-id" });
      session.emit({ ...event("subagent.completed", { toolCallId: "spawn", agentName: "child", agentDisplayName: "Child" }), agentId: "child-id" });
      session.emit(event("tool.execution_complete", { toolCallId: "spawn", success: true, result: { content: "Child completed" } }));
      session.emit(event("session.idle", {}));
      return { success: true };
    });
    const second = await collect(f.adapter.stream(input({ tools: frontend, messages: [result("c0", "browser answer")] })));
    expect(second.find((event) => event.type === "SUBAGENT_STARTED")?.subagentRunId).toBe("child-id");
    expect(second.filter((event) => event.type === "TOOL_CALL_RESULT").map((event) => event.toolCallId)).toEqual(["spawn"]);
    expect(session.send).toHaveBeenCalledTimes(1);
    await expect(lastValueFrom(from([...first, ...second]).pipe(verifyEvents(), toArray()))).resolves.toHaveLength(first.length + second.length);
    await f.adapter.close();
  });
});
