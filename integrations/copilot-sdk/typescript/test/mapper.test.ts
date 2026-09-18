import { describe, expect, it } from "vitest";
import { EventSchemas } from "@ag-ui/core";
import { verifyEvents } from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import { CopilotEventMapper, boundedText, type CopilotSessionEvent } from "../src/mapper.js";

let sequence = 0;
export function event(type: CopilotSessionEvent["type"], data: Record<string, unknown>, extra = {}): CopilotSessionEvent {
  return { type, data, id: `event-${++sequence}`, timestamp: "2026-09-16T00:00:00Z", parentId: "chronological-only", ...extra } as CopilotSessionEvent;
}
function mapper(options = {}) { return new CopilotEventMapper({ threadId: "thread", runId: "run", ...options }); }

describe("native typed event mapper", () => {
  it("opens once, deduplicates streaming/final text, closes orphaned reasoning and one terminal", async () => {
    const m = mapper();
    const delta = event("assistant.message_delta", { messageId: "m", deltaContent: "hel" });
    const trace = [
      ...m.start(), ...m.start(), ...m.mapEvent(delta), ...m.mapEvent(delta),
      ...m.mapEvent(event("assistant.message", { messageId: "m", content: "hello" })),
      ...m.mapEvent(event("assistant.message", { messageId: "m", content: "hello" })),
      ...m.mapEvent(event("assistant.reasoning_delta", { reasoningId: "r", deltaContent: "readable" })),
      ...m.finish(), ...m.finish(),
    ];
    expect(trace.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta).join("")).toBe("hello");
    expect(trace.filter((e) => e.type === "TEXT_MESSAGE_END")).toHaveLength(1);
    expect(trace.filter((e) => e.type === "REASONING_MESSAGE_END")).toHaveLength(1);
    expect(trace.filter((e) => e.type === "RUN_FINISHED")).toHaveLength(1);
    for (const mapped of trace) expect(EventSchemas.safeParse(mapped).success, JSON.stringify(mapped)).toBe(true);
    await lastValueFrom(from(trace).pipe(verifyEvents(), toArray()));
  });

  it("maps full-only text and reasoning, but never raw/opaque reasoning", () => {
    const m = mapper();
    expect(m.mapEvent(event("assistant.message", { messageId: "m", content: "answer", encryptedContent: "secret", reasoningText: "untrusted" }))
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta)).toEqual(["answer"]);
    expect(m.mapEvent(event("assistant.reasoning", { reasoningId: "r", content: "readable" }))
      .filter((e) => e.type === "REASONING_MESSAGE_CONTENT").map((e) => e.delta)).toEqual(["readable"]);
    expect(m.mapEvent(event("assistant.streaming_delta", { totalResponseSizeBytes: 10 }))).toEqual([]);
  });

  it("buffers tool-name/argument fragments until authoritative name; handoff has no result", () => {
    const m = mapper();
    m.start();
    expect(m.mapEvent(event("assistant.tool_call_delta", { toolCallId: "call", toolName: "fr", inputDelta: '{"a":' }))).toEqual([]);
    m.mapEvent(event("assistant.tool_call_delta", { toolCallId: "call", toolName: "frontend", inputDelta: "1}" }));
    const trace = m.mapEvent(event("assistant.message", {
      messageId: "m", content: "", toolRequests: [{ toolCallId: "call", name: "frontend", arguments: { a: 1 } }],
    }));
    expect(trace.map((e) => e.type)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
    expect(trace[0]?.toolCallName).toBe("frontend");
    expect(trace[1]?.delta).toBe('{"a":1}');
    expect(m.mapEvent(event("external_tool.requested", { toolCallId: "call", toolName: "frontend", requestId: "private", sessionId: "native", arguments: { a: 1 } }))).toEqual([]);
    expect(m.finish().map((e) => e.type)).toEqual(["RUN_FINISHED"]);
  });

  it("emits real tool partial output, progress and authoritative final without duplication", () => {
    const m = mapper();
    const trace = [
      ...m.mapEvent(event("tool.execution_start", { toolCallId: "c", toolName: "bash", arguments: { command: "printf hi" }, shellToolInfo: { displayCommand: "printf hi", possiblePaths: [], hasWriteFileRedirection: false } })),
      ...m.mapEvent(event("tool.execution_partial_result", { toolCallId: "c", partialOutput: "hi" })),
      ...m.mapEvent(event("tool.execution_progress", { toolCallId: "c", progressMessage: "running" })),
      ...m.mapEvent(event("tool.execution_complete", { toolCallId: "c", success: false, result: { content: "hi" }, shellExecution: { exitCode: 2 } })),
      ...m.mapEvent(event("tool.execution_complete", { toolCallId: "c", success: false, result: { content: "hi" } })),
    ];
    const activity = trace.filter((e) => e.type === "ACTIVITY_SNAPSHOT");
    expect(activity[0]?.content.output).toBe("");
    expect(activity[1]?.content.output).toBe("hi");
    expect(activity.at(-1)?.content).toMatchObject({ output: "hi", status: "error", exitCode: 2, command: "printf hi" });
    expect(trace.filter((e) => e.type === "TOOL_CALL_RESULT")).toHaveLength(1);
  });

  it("preserves empty results and error messages honestly", () => {
    const m = mapper();
    expect(m.mapEvent(event("tool.execution_complete", { toolCallId: "empty", success: true, result: { content: "" } }))[0]?.content).toBe("");
    expect(m.mapEvent(event("tool.execution_complete", { toolCallId: "failure", success: false, error: { message: "failed" } }))[0]?.content).toBe("failed");
  });

  it("bounds activity output by bytes, with truncation and valid UTF8", () => {
    const m = mapper({ maxOutputBytes: 5 });
    const trace = m.mapEvent(event("tool.execution_partial_result", { toolCallId: "c", partialOutput: "a😀b" }));
    expect(trace[0]?.content).toMatchObject({ output: "a😀", truncated: true });
    expect(boundedText("😀😀", 5)).toBe("😀");
    expect(() => m.mapEvent(event("assistant.message_delta", { messageId: "m", deltaContent: "123456" }))).toThrow("output limit");
  });

  it("normalizes real shell cumulative snapshots without duplicated lines", () => {
    const m = mapper();
    m.mapEvent(event("tool.execution_start", { toolCallId: "shell", toolName: "bash", arguments: {} }));
    m.mapEvent(event("tool.execution_partial_result", { toolCallId: "shell", partialOutput: "first\n" }));
    const second = m.mapEvent(event("tool.execution_partial_result", { toolCallId: "shell", partialOutput: "first\nsecond\n" }));
    const repeated = m.mapEvent(event("tool.execution_partial_result", { toolCallId: "shell", partialOutput: "first\nsecond\n" }));
    expect(second[0]?.content.output).toBe("first\nsecond\n");
    expect(repeated[0]?.content.output).toBe("first\nsecond\n");
  });

  it.each([true, false])("uses explicit shell metadata, never a prefix heuristic (shell=%s)", (shell) => {
    const m = mapper();
    m.mapEvent(event("tool.execution_start", {
      toolCallId: "call", toolName: "custom-name", arguments: { command: "actual command" },
      ...(shell ? { shellToolInfo: { displayCommand: "", possiblePaths: [], hasWriteFileRedirection: false } } : {}),
    }));
    m.mapEvent(event("tool.execution_partial_result", { toolCallId: "call", partialOutput: "a" }));
    m.mapEvent(event("tool.execution_partial_result", { toolCallId: "call", partialOutput: "ab" }));
    const repeated = m.mapEvent(event("tool.execution_partial_result", { toolCallId: "call", partialOutput: "ab" }));
    expect(repeated[0]?.content.output).toBe(shell ? "ab" : "aabab");
    expect(repeated[0]?.content.command).toBe(shell ? "actual command" : undefined);
  });

  it("preserves authoritative result.content and its runtime trailer in both result and final activity", () => {
    const m = mapper();
    m.mapEvent(event("tool.execution_start", { toolCallId: "call", toolName: "bash", arguments: { command: "actual command" } }));
    m.mapEvent(event("tool.execution_partial_result", { toolCallId: "call", partialOutput: "earlier output" }));
    const content = "final output\n<shellId: actual-id completed with exit code 7>";
    const trace = m.mapEvent(event("tool.execution_complete", {
      toolCallId: "call", success: true, result: { content, detailedContent: "different rendering" },
      shellExecution: { exitCode: 7 },
    }));
    expect(trace.find((event) => event.type === "TOOL_CALL_RESULT")?.content).toBe(content);
    expect(trace.at(-1)?.content).toMatchObject({ output: content, status: "error", exitCode: 7, command: "actual command" });
  });

  it("limits retained events and argument buffers", () => {
    const m = mapper({ maxEvents: 1 });
    m.mapEvent(event("session.idle", {}));
    expect(m.mapEvent(event("assistant.message", { messageId: "m", content: "late" }))).toEqual([]);
    const limited = mapper({ maxEvents: 1, maxOutputBytes: 5 });
    limited.mapEvent(event("assistant.streaming_delta", {}));
    expect(() => limited.mapEvent(event("assistant.streaming_delta", {}))).toThrow("event limit");
    expect(() => mapper({ maxOutputBytes: 2 }).mapEvent(event("assistant.tool_call_delta", { toolCallId: "c", inputDelta: "123" }))).toThrow("arguments limit");
  });

  it("isolates interleaved child messages and uses real agent ancestry, not log parentId", () => {
    const m = mapper();
    m.mapEvent(event("subagent.started", { toolCallId: "spawn", agentName: "a", agentDescription: "child", agentDisplayName: "A" }, { agentId: "agent-a" }));
    const child = m.mapEvent(event("subagent.started", { toolCallId: "spawn-b", agentName: "b", agentDescription: "grandchild", agentDisplayName: "B", parentId: "agent-a" }, { agentId: "agent-b" }));
    expect(child.find((e) => e.type === "ACTIVITY_SNAPSHOT")?.content.parentToolCallId).toBe("spawn");
    const a = m.mapEvent(event("assistant.message_delta", { messageId: "same", deltaContent: "A" }, { agentId: "agent-a" }));
    const b = m.mapEvent(event("assistant.message_delta", { messageId: "same", deltaContent: "B" }, { agentId: "agent-b" }));
    expect(a[0]?.messageId).not.toBe(b[0]?.messageId);
    const tool = m.mapEvent(event("tool.execution_start", { toolCallId: "nested", toolName: "lookup", arguments: {} }, { agentId: "agent-b" }));
    expect(tool.at(-1)?.content.parentToolCallId).toBe("spawn-b");
    expect(JSON.stringify(tool)).not.toContain("chronological-only");
  });

  it("passes the canonical verifier with nested ancestry and orphan reasoning closed at each child boundary", async () => {
    const m = mapper();
    const trace = [
      ...m.start(),
      ...m.mapEvent(event("subagent.started", {
        toolCallId: "spawn-a", agentName: "a", agentDescription: "parent", agentDisplayName: "A",
      }, { agentId: "a" })),
      ...m.mapEvent(event("subagent.started", {
        toolCallId: "spawn-b", agentName: "b", agentDescription: "child", agentDisplayName: "B", parentId: "a",
      }, { agentId: "b" })),
      ...m.mapEvent(event("assistant.reasoning_delta", { reasoningId: "same", deltaContent: "B reason" }, { agentId: "b" })),
      ...m.mapEvent(event("subagent.completed", { toolCallId: "spawn-b" })),
      ...m.mapEvent(event("assistant.reasoning_delta", { reasoningId: "same", deltaContent: "A reason" }, { agentId: "a" })),
      ...m.mapEvent(event("subagent.completed", { toolCallId: "spawn-a" })),
      ...m.finish(),
    ];
    expect(trace.filter((event) => event.type === "SUBAGENT_STARTED")).toHaveLength(2);
    expect(trace.filter((event) => event.type === "SUBAGENT_FINISHED")).toHaveLength(2);
    expect(trace.find((event) => event.type === "SUBAGENT_STARTED" && event.subagentRunId === "b"))
      .toMatchObject({ parentSubagentRunId: "a", parentToolCallId: "spawn-b" });
    for (const child of ["a", "b"]) {
      const terminal = trace.findIndex((event) => event.type === "SUBAGENT_FINISHED" && event.subagentRunId === child);
      for (const type of ["REASONING_MESSAGE_END", "REASONING_END"]) {
        const closure = trace.findIndex((event) => event.type === type && event.messageId === `${child}:same`);
        expect(closure).toBeGreaterThan(-1);
        expect(closure).toBeLessThan(terminal);
      }
    }
    expect(JSON.stringify(trace)).not.toContain("chronological-only");
    await lastValueFrom(from(trace).pipe(verifyEvents(), toArray()));
  });

  it("cancellation closes running activity without invented results", () => {
    const m = mapper();
    m.start();
    m.mapEvent(event("tool.execution_start", { toolCallId: "c", toolName: "slow", arguments: {} }));
    const trace = m.finish("Cancelled", true);
    expect(trace[0]?.content.status).toBe("cancelled");
    expect(trace.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "CANCELLED" });
    expect(trace.some((e) => e.type === "TOOL_CALL_RESULT")).toBe(false);
  });

  it.each(["abort", "agent.interrupted"] as const)("maps native %s without waiting for tool completion", async (type) => {
    const m = mapper();
    const trace = [
      ...m.start(),
      ...m.mapEvent(event("tool.execution_start", { toolCallId: "call", toolName: "bash", arguments: { command: "safe fixture" } })),
      ...m.mapEvent(event("tool.execution_partial_result", { toolCallId: "call", partialOutput: "partial" })),
      ...m.mapEvent(event(type, {})),
      ...m.mapEvent(event(type === "abort" ? "agent.interrupted" : "abort", {})),
      ...m.mapEvent(event("session.idle", {})),
      ...m.finish(),
    ];
    expect(trace.filter((event) => event.type === "ACTIVITY_SNAPSHOT").at(-1)?.content)
      .toMatchObject({ status: "cancelled", output: "partial", command: "safe fixture" });
    expect(trace.filter((event) => event.type === "RUN_ERROR")).toHaveLength(1);
    expect(trace.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "CANCELLED" });
    expect(trace.some((event) => event.type === "TOOL_CALL_RESULT" || event.type === "RUN_FINISHED")).toBe(false);
    await lastValueFrom(from(trace).pipe(verifyEvents(), toArray()));
  });

  it("retains known child identity and name when completion omits optional runtime metadata", () => {
    const m = mapper();
    const start = m.mapEvent(event("subagent.started", {
      toolCallId: "spawn", parentId: "root-registry", agentName: "reviewer",
      agentDisplayName: "Reviewer", agentDescription: "Review",
    }, { agentId: "child" }));
    expect(start.find((e) => e.type === "SUBAGENT_STARTED")?.parentSubagentRunId).toBeUndefined();
    m.mapEvent(event("assistant.reasoning_delta", { reasoningId: "r", deltaContent: "Readable" }, { agentId: "child" }));
    const completed = m.mapEvent(event("subagent.completed", { toolCallId: "spawn" }));
    expect(completed.find((e) => e.type === "SUBAGENT_FINISHED")?.subagentRunId).toBe("child");
    expect(completed.find((e) => e.type === "REASONING_MESSAGE_END")?.messageId).toBe("child:r");
    expect(completed.find((e) => e.type === "ACTIVITY_SNAPSHOT")?.content.agentName).toBe("reviewer");
  });

  it.each(["root-uuid", "child-uuid"])("omits parent %s unless it was announced before this child", async (parentId) => {
    const m = mapper();
    const trace = [
      ...m.start(),
      ...m.mapEvent(event("subagent.started", {
        toolCallId: "t1", parentId, agentName: "probe",
      }, { agentId: "child-uuid" })),
      ...m.mapEvent(event("subagent.completed", { toolCallId: "t1" })),
      ...m.finish(),
    ];
    const start = trace.find((event) => event.type === "SUBAGENT_STARTED");
    expect(start).toMatchObject({ subagentRunId: "child-uuid", parentToolCallId: "t1", name: "probe" });
    expect(start?.parentSubagentRunId).toBeUndefined();
    expect(trace.find((event) => event.type === "ACTIVITY_SNAPSHOT")?.content.parentToolCallId).toBeUndefined();
    await lastValueFrom(from(trace).pipe(verifyEvents(), toArray()));
  });

  it.each([undefined, "child"])("correlates text, reasoning, every tool event and activity for agent %s", (agentId) => {
    const m = mapper();
    const scope = agentId ? { agentId } : {};
    if (agentId) m.mapEvent(event("subagent.started", {
      toolCallId: "spawn", agentName: "worker", agentDisplayName: "Worker", agentDescription: "Known child",
    }, scope));
    const trace = [
      ...m.mapEvent(event("assistant.message_delta", { messageId: "m", deltaContent: "text" }, scope)),
      ...m.mapEvent(event("assistant.reasoning_delta", { reasoningId: "r", deltaContent: "reason" }, scope)),
      ...m.mapEvent(event("tool.execution_start", { toolCallId: "call", toolName: "lookup", arguments: { label: "test" } }, scope)),
      ...m.mapEvent(event("tool.execution_partial_result", { toolCallId: "call", partialOutput: "partial" }, scope)),
      ...m.mapEvent(event("tool.execution_complete", { toolCallId: "call", success: true, result: { content: "done" } }, scope)),
      ...m.finish(),
    ];
    for (const mapped of trace) {
      expect(mapped.subagentRunId).toBe(agentId);
      expect(EventSchemas.safeParse(mapped).success).toBe(true);
    }
    for (const type of ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"]) {
      expect(trace.filter((mapped) => mapped.type === type)).toHaveLength(1);
    }
    expect(trace.find((mapped) => mapped.type === "TEXT_MESSAGE_START")?.messageId).toBe(agentId ? "child:m" : "m");
  });

  it("fills child tool attribution before emitting buffered argument fragments", () => {
    const m = mapper();
    m.mapEvent(event("subagent.started", {
      toolCallId: "spawn", agentName: "worker", agentDisplayName: "Worker", agentDescription: "Known child",
    }, { agentId: "child" }));
    m.mapEvent(event("assistant.tool_call_delta", { toolCallId: "call", inputDelta: '{"label":' }));
    const trace = m.mapEvent(event("assistant.message", {
      messageId: "m", content: "", toolRequests: [{ toolCallId: "call", name: "lookup", arguments: { label: "test" } }],
    }, { agentId: "child" }));
    expect(trace.map((mapped) => mapped.type)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
    expect(trace.every((mapped) => mapped.subagentRunId === "child")).toBe(true);
  });
});
