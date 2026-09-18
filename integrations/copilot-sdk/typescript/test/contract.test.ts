import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EventSchemas, type BaseEvent } from "@ag-ui/core";
import { verifyEvents } from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import type { SessionEvent } from "@github/copilot-sdk";
import { CopilotEventMapper } from "../src/mapper.js";

type ContractCase = {
  name: string;
  events: Record<string, unknown>[];
  expect: {
    error?: string;
    types?: string[]; text?: string[]; reasoning?: string[]; toolArguments?: unknown[];
    toolResults?: string[]; toolResultContains?: string[]; counts?: Record<string, number>;
    lastToolActivity?: Record<string, unknown>; activityOutputs?: string[];
    distinctTextMessageIds?: number; forbidden?: string[];
  };
};
const contract = JSON.parse(readFileSync(new URL("../../fixtures/contract.json", import.meta.url), "utf8")) as {
  envelopeDefaults: Record<string, unknown>; cases: ContractCase[];
};
function grouped(trace: BaseEvent[], type: string, key: string) {
  const values = new Map<string, string>();
  for (const e of trace) if (e.type === type) values.set(String(e[key]), (values.get(String(e[key])) ?? "") + String(e.delta));
  return [...values.values()];
}

describe("shared Python/TypeScript synthetic contract", () => {
  it.each(contract.cases)("$name", async (test) => {
    const runMapper = new CopilotEventMapper({ threadId: "fixture", runId: "fixture-run" });
    const runTrace = runMapper.start();
    let failure: string | undefined;
    try {
      for (const event of test.events) runTrace.push(...runMapper.mapEvent({ ...contract.envelopeDefaults, ...event } as SessionEvent));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toBe(test.expect.error);
    runTrace.push(...runMapper.finish(failure));
    for (const event of runTrace) expect(EventSchemas.safeParse(event).success, JSON.stringify(event)).toBe(true);
    await lastValueFrom(from(runTrace).pipe(verifyEvents(), toArray()));

    const mapper = new CopilotEventMapper({ threadId: "fixture", runId: "fixture-run" });
    if (test.expect.error) {
      const emitted: BaseEvent[] = [];
      expect(() => {
        for (const event of test.events) emitted.push(...mapper.mapEvent({ ...contract.envelopeDefaults, ...event } as SessionEvent));
      }).toThrow(test.expect.error);
      expect(emitted).toEqual([]);
      return;
    }
    const trace = [
      ...test.events.flatMap((event) => mapper.mapEvent({ ...contract.envelopeDefaults, ...event } as SessionEvent)),
      ...mapper.finish(),
    ];
    const expected = test.expect;
    for (const e of trace) expect(EventSchemas.safeParse(e).success, JSON.stringify(e)).toBe(true);
    if (expected.types) expect(trace.map((e) => e.type)).toEqual(expected.types);
    if (expected.text) expect(grouped(trace, "TEXT_MESSAGE_CONTENT", "messageId")).toEqual(expected.text);
    if (expected.reasoning) expect(grouped(trace, "REASONING_MESSAGE_CONTENT", "messageId")).toEqual(expected.reasoning);
    if (expected.toolArguments) expect(grouped(trace, "TOOL_CALL_ARGS", "toolCallId").map((args) => JSON.parse(args))).toEqual(expected.toolArguments);
    const results = trace.filter((e) => e.type === "TOOL_CALL_RESULT").map((e) => e.content);
    if (expected.toolResults) expect(results).toEqual(expected.toolResults);
    for (const part of expected.toolResultContains ?? []) expect(JSON.stringify(results)).toContain(part);
    for (const [type, count] of Object.entries(expected.counts ?? {})) expect(trace.filter((e) => e.type === type)).toHaveLength(count);
    if (expected.lastToolActivity) expect(trace.filter((e) => e.type === "ACTIVITY_SNAPSHOT" && e.activityType === "copilot-sdk:tool").at(-1)?.content).toMatchObject(expected.lastToolActivity);
    if (expected.activityOutputs) expect(trace.filter((e) => e.type === "ACTIVITY_SNAPSHOT" && e.activityType === "copilot-sdk:tool").map((e) => e.content.output)).toEqual(expected.activityOutputs);
    if (expected.distinctTextMessageIds) expect(new Set(trace.filter((e) => e.type === "TEXT_MESSAGE_START").map((e) => e.messageId)).size).toBe(expected.distinctTextMessageIds);
    for (const forbidden of expected.forbidden ?? []) expect(JSON.stringify(trace)).not.toContain(forbidden);
    expect(trace.some((e) => e.type === "RAW")).toBe(false);
    for (const [startType, endType, id, contentType] of [
      ["TEXT_MESSAGE_START", "TEXT_MESSAGE_END", "messageId", "TEXT_MESSAGE_CONTENT"],
      ["REASONING_MESSAGE_START", "REASONING_MESSAGE_END", "messageId", "REASONING_MESSAGE_CONTENT"],
      ["REASONING_START", "REASONING_END", "messageId", "REASONING_MESSAGE_CONTENT"],
      ["TOOL_CALL_START", "TOOL_CALL_END", "toolCallId", "TOOL_CALL_ARGS"],
    ] as const) {
      const starts = trace.filter((e) => e.type === startType);
      expect(new Set(starts.map((e) => e[id])).size).toBe(starts.length);
      expect(trace.filter((e) => e.type === endType)).toHaveLength(starts.length);
      for (const start of starts) {
        const end = trace.filter((e) => e.type === endType && e[id] === start[id]);
        expect(end).toHaveLength(1);
        expect(trace.indexOf(end[0]!)).toBeGreaterThan(trace.indexOf(start));
      }
      for (const content of trace.filter((e) => e.type === contentType)) {
        const start = starts.find((e) => e[id] === content[id]);
        const end = trace.find((e) => e.type === endType && e[id] === content[id]);
        expect(start).toBeDefined();
        expect(end).toBeDefined();
        expect(trace.indexOf(content)).toBeGreaterThan(trace.indexOf(start!));
        expect(trace.indexOf(content)).toBeLessThan(trace.indexOf(end!));
      }
    }
    for (const result of trace.filter((e) => e.type === "TOOL_CALL_RESULT")) {
      const call = trace.find((e) => e.type === "TOOL_CALL_START" && e.toolCallId === result.toolCallId);
      const end = trace.find((e) => e.type === "TOOL_CALL_END" && e.toolCallId === result.toolCallId);
      expect(call).toBeDefined();
      expect(end).toBeDefined();
      expect(trace.indexOf(result)).toBeGreaterThan(trace.indexOf(end!));
    }
    for (const start of trace.filter((e) => e.type === "SUBAGENT_STARTED")) {
      const terminal = trace.filter((e) => (e.type === "SUBAGENT_FINISHED" || e.type === "SUBAGENT_ERROR") && e.subagentRunId === start.subagentRunId);
      expect(terminal).toHaveLength(1);
      expect(trace.indexOf(terminal[0]!)).toBeGreaterThan(trace.indexOf(start));
      for (const closure of trace.filter((e) => e.subagentRunId === start.subagentRunId &&
        ["TEXT_MESSAGE_END", "REASONING_MESSAGE_END", "REASONING_END"].includes(e.type))) {
        expect(trace.indexOf(closure)).toBeLessThan(trace.indexOf(terminal[0]!));
      }
    }
  });
});
