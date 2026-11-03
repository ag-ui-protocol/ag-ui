import { vi } from "vitest";
import { firstValueFrom, from, toArray } from "rxjs";
import { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { AbstractAgent } from "@/agent";
import { defaultApplyEvents } from "../default";
import fixture from "./fixtures/strands-native-resume.json";

// Captured from test_cold_native_resume_preserves_transcript with a stale
// calculator result and emit_messages_snapshot=False, using the real Strands SDK.
it("corrects a resumed result in place without snapshots or duplicate history", async () => {
  const input = structuredClone(fixture.input) as RunAgentInput;
  input.messages[2]!.metadata = { source: "before-pause" };
  const onNewMessage = vi.fn();
  const events = fixture.events as BaseEvent[];
  const original = structuredClone(input.messages);
  const agent = { messages: structuredClone(original), state: {} } as AbstractAgent;
  expect(events.some((e) => e.type === "MESSAGES_SNAPSHOT")).toBe(false);

  const updates = await firstValueFrom(
    defaultApplyEvents(input, from(events), agent, [{ onNewMessage }]).pipe(toArray()),
  );
  const messages = updates.filter((update) => update.messages).at(-1)!.messages!;
  const results = messages.filter((m) => m.role === "tool");
  expect(results.map((m) => m.toolCallId)).toEqual(["completed-calculator", "native-approval"]);
  expect(messages.slice(0, 2)).toEqual(original.slice(0, 2));
  expect(results[0]).toMatchObject({
    id: "existing-calculator",
    metadata: { source: "before-pause" },
    content: '{"expression":"6*7","result":42}',
  });
  expect(results[1]!.content).toBe('{"approved":{"response":true}}');
  expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "Done." });
  expect(new Set(messages.map((m) => m.id)).size).toBe(messages.length);
  expect(input.messages).toEqual(original);
  expect(onNewMessage.mock.calls.map(([args]) => args.message.id)).not.toContain(
    "existing-calculator",
  );
  for (const update of updates) {
    if (update.messages) {
      expect(new Set(update.messages.map((m) => m.id)).size).toBe(update.messages.length);
    }
  }
});
