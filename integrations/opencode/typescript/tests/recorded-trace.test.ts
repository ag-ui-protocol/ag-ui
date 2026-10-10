import { readFileSync } from "node:fs";
import { it, expect } from "vitest";
import { EventSchemas } from "@ag-ui/core/schemas";
import type { BaseEvent } from "@ag-ui/core";
import type { Event } from "@opencode-ai/sdk/v2";
import { EventMapper } from "../src/event-mapper";

it("maps snapshots captured from OpenCode 1.18.32 into valid complete tool/text lifecycles", () => {
  const trace = JSON.parse(
    readFileSync(
      new URL("./fixtures/opencode-1.18.32.json", import.meta.url),
      "utf8",
    ),
  ) as Event[];
  const events: BaseEvent[] = [];
  const mapper = new EventMapper((e) => {
    EventSchemas.parse(e);
    events.push(e);
  }, []);
  const assistants = new Set(
    trace
      .filter(
        (e) =>
          e.type === "message.updated" &&
          e.properties.info.role === "assistant",
      )
      .map((e) => (e.type === "message.updated" ? e.properties.info.id : "")),
  );
  for (const event of trace)
    if (
      event.type === "message.part.updated" &&
      assistants.has(event.properties.part.messageID)
    )
      mapper.part(event.properties.part);
  mapper.close(true);
  expect(events.some((e) => e.type === "TEXT_MESSAGE_CONTENT")).toBe(true);
  const starts = events.filter((e) => e.type === "TOOL_CALL_START");
  // The denied bash call has only a pending snapshot in the raw trace.
  // Pending inputs are deliberately not exposed; the completed bash/question
  // snapshots must each produce one complete lifecycle.
  expect(starts.map((e) => e.toolCallName)).toEqual(["bash", "question"]);
  for (const start of starts) {
    const lifecycle = events
      .filter((e) => e.toolCallId === start.toolCallId)
      .map((e) => e.type);
    expect(lifecycle).toEqual([
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
    ]);
  }
  expect(trace.some((e) => e.type === "permission.asked")).toBe(true);
  expect(trace.some((e) => e.type === "question.asked")).toBe(true);
  expect(trace.some((e) => e.type === "session.error")).toBe(true);
});
