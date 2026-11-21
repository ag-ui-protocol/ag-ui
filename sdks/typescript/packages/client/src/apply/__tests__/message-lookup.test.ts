import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/core";
import { MessageLookup } from "../message-lookup";

// The answers MessageLookup stands in for.
const scanIndexOf = (messages: Message[], id: unknown) => messages.findIndex((m) => m.id === id);
const scanOwner = (messages: Message[], toolCallId: unknown) =>
  messages.find((m) =>
    (m as { toolCalls?: { id: unknown }[] }).toolCalls?.some((tc) => tc.id === toolCallId),
  );

// Small id pools so random lists repeat ids and tool call ids.
const ids = ["a", "b", "c", "d", "e", "f"];
const callIds = ["c1", "c2", "c3", "c4"];

// Deterministic PRNG so a failure reproduces.
const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const makeMessage = (next: () => number, n: number): Message => {
  const id = ids[Math.floor(next() * ids.length)];
  if (next() < 0.5) {
    const toolCalls = callIds
      .filter(() => next() < 0.3)
      .map((callId) => ({
        id: callId,
        type: "function" as const,
        function: { name: "f", arguments: "" },
      }));
    return { id, role: "assistant", toolCalls, content: String(n) } as Message;
  }
  return { id, role: "tool", toolCallId: "c1", content: String(n) } as Message;
};

describe("MessageLookup", () => {
  it("answers like a front-to-back scan through appends, inserts, tool calls and replacements", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = random(seed);
      const lookup = new MessageLookup();
      let messages: Message[] = [];
      for (let step = 0; step < 60; step++) {
        const op = next();
        if (op < 0.35) {
          messages.push(makeMessage(next, step));
        } else if (op < 0.5 && messages.length > 0) {
          const at = Math.floor(next() * messages.length);
          lookup.insertedBefore(messages, at);
          messages.splice(at, 0, makeMessage(next, step));
        } else if (op < 0.6 && messages.length > 0) {
          const owner = messages[Math.floor(next() * messages.length)] as Message & {
            toolCalls?: unknown[];
          };
          const callId = callIds[Math.floor(next() * callIds.length)];
          owner.toolCalls ??= [];
          owner.toolCalls.push({
            id: callId,
            type: "function",
            function: { name: "f", arguments: "" },
          });
          lookup.addedToolCall(messages, owner, callId);
        } else if (op < 0.7 && messages.length > 0) {
          // Replace an entry with a copy under the same id: no report needed.
          const at = Math.floor(next() * messages.length);
          messages[at] = { ...messages[at], content: `replaced ${step}` } as Message;
        } else if (op < 0.75) {
          // A new array, as after a snapshot or a subscriber's replacement.
          messages = messages.filter(() => next() < 0.8);
        }
        for (const id of [...ids, "missing", undefined]) {
          expect(lookup.indexOf(messages, id as string)).toBe(scanIndexOf(messages, id));
          expect(lookup.find(messages, id as string)).toBe(messages[scanIndexOf(messages, id)]);
        }
        for (const callId of [...callIds, "missing"]) {
          expect(lookup.toolCallOwner(messages, callId)).toBe(scanOwner(messages, callId));
        }
      }
    }
  });

  it("finds a message whose id is missing, as an === scan does", () => {
    const lookup = new MessageLookup();
    const messages = [
      { role: "user", content: "x" } as Message,
      { id: "b", role: "user", content: "y" } as Message,
    ];
    expect(lookup.indexOf(messages, undefined as unknown as string)).toBe(0);
    expect(lookup.indexOf(messages, "b")).toBe(1);
  });
});
