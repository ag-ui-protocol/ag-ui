import { describe, it, expect } from "vitest";
import { EventSchemas } from "@ag-ui/core/schemas";
import { EventMapper } from "../src/event-mapper";
import type { BaseEvent } from "@ag-ui/core";

const text = (value: string) => ({
  id: "p",
  messageID: "m",
  sessionID: "s",
  type: "text" as const,
  text: value,
});
const tool = (status: string, input = { file: "README.md" }) =>
  ({
    id: "t",
    messageID: "m",
    sessionID: "s",
    type: "tool",
    callID: "call",
    tool: "read",
    state: {
      status,
      input,
      raw: "",
      output: "Contents",
      title: "read",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }) as any;

describe("event mapper", () => {
  it("deduplicates snapshots and replaces revised text without corrupting history", () => {
    const events: BaseEvent[] = [];
    const mapper = new EventMapper(
      (e) => events.push(e),
      [{ id: "u", role: "user", content: "hello" }],
    );
    mapper.part(text("Hel"));
    mapper.part(text("Hello"));
    mapper.part(text("Hello"));
    mapper.part(text("Hi"));
    mapper.close();
    expect(events.map((e) => e.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "MESSAGES_SNAPSHOT",
      "TEXT_MESSAGE_END",
    ]);
    expect(events[2].delta).toBe("lo");
    expect(events[3].messages).toEqual([
      { id: "u", role: "user", content: "hello" },
      { id: "m:p", role: "assistant", content: "Hi" },
    ]);
    events.forEach((e) => EventSchemas.parse(e));
  });
  it("emits one ordered tool lifecycle and safely redacts failures", () => {
    const events: BaseEvent[] = [];
    const mapper = new EventMapper((e) => events.push(e), []);
    mapper.part(tool("pending"));
    mapper.part(tool("running"));
    mapper.part(tool("running"));
    mapper.part(tool("error"));
    mapper.part(tool("error"));
    expect(events.map((e) => e.type)).toEqual([
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
    ]);
    expect(events[3].content).toBe("OpenCode tool failed");
    events.forEach((e) => EventSchemas.parse(e));
  });
  it("closes unfinished text/tools exactly once on failure", () => {
    const events: BaseEvent[] = [];
    const mapper = new EventMapper((e) => events.push(e), []);
    mapper.part(text("Partial"));
    mapper.part(tool("running"));
    mapper.close(true);
    mapper.close(true);
    expect(events.filter((e) => e.type === "TEXT_MESSAGE_END")).toHaveLength(1);
    expect(events.filter((e) => e.type === "TOOL_CALL_RESULT")).toHaveLength(1);
  });
  it("rehydrates an interrupted mapper without replaying tool starts", () => {
    const events: BaseEvent[] = [];
    const mapper = new EventMapper((e) => events.push(e), []);
    mapper.part(tool("running"));
    mapper.close();
    const restored = new EventMapper(
      (e) => events.push(e),
      [],
      structuredClone(mapper.state),
    );
    restored.part(tool("completed"));
    expect(events.map((e) => e.type)).toEqual([
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
    ]);
  });
});
