import { expect, it } from "vitest";
import { CopilotEventMapper } from "../src/index.js";

it("F4 rejects or buffers a child event until an authoritative child start", () => {
  const mapper = new CopilotEventMapper({ threadId: "thread", runId: "run" });
  let events;
  try {
    events = mapper.mapEvent({
      id: "unannounced", timestamp: new Date(0).toISOString(), parentId: null,
      ephemeral: true, type: "assistant.message_delta", agentId: "unknown-child",
      data: { messageId: "message", deltaContent: "child content" },
    });
  } catch (error) {
    // An explicit unknown-child rejection is safe, not a fabricated root message.
    if (!(error instanceof Error) || !/unknown.*(child|agent)|unannounced|subagent/i.test(error.message)) throw error;
    return;
  }
  expect(events).toEqual([]);
});
