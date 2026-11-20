import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import type { BaseMessage } from "@langchain/core/messages";
import { EventType, RunAgentInput } from "@ag-ui/client";
import { firstValueFrom, toArray } from "rxjs";
import { LangChainAgent } from "../agent";

function makeInput(): RunAgentInput {
  return {
    threadId: "t-1",
    runId: "r-1",
    messages: [{ id: "m1", role: "user", content: "hi" }],
    tools: [],
    context: [],
    forwardedProps: {},
  } as RunAgentInput;
}

describe("LangChainAgent — direct-model pattern with a prompt", () => {
  // Guards against the prompt being prepended as a plain object: a real
  // LangChain chat model coerces its input messages, rejects that object with
  // MESSAGE_COERCION_FAILURE, and every run configured with `prompt` errored.
  it("hands the model a real system message and completes the run", async () => {
    let seen: BaseMessage[] = [];
    class RecordingModel extends FakeListChatModel {
      // The fake's own bindTools returns a fresh, non-recording model.
      bindTools() {
        return this;
      }
      async *_streamResponseChunks(messages: BaseMessage[], ...rest: any[]) {
        seen = messages;
        yield* super._streamResponseChunks(messages, ...(rest as [any, any]));
      }
    }
    const model = new RecordingModel({ responses: ["hello"] });

    const agent = new LangChainAgent({ model, prompt: "You are terse." });
    const events = await firstValueFrom(agent.run(makeInput()).pipe(toArray()));

    expect(events.map((e) => e.type)).not.toContain(EventType.RUN_ERROR);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(seen[0]._getType()).toBe("system");
    expect(seen[0].content).toBe("You are terse.");
  });
});
