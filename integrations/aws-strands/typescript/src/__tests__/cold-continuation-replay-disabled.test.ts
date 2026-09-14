/**
 * A frontend-tool continuation that arrives on a cold agent with
 * `replayHistoryIntoStrands: false` and no session manager.
 *
 * Cold here means the adapter holds no cached Strands `Agent` for the thread,
 * so it builds one and seeds it from `RunAgentInput.messages`. A continuation
 * routed to a fresh process, or arriving after a restart, looks like this.
 *
 * With replay disabled the seed is the whole history, and its last message is
 * the user-role `toolResult`. The synthetic continuation prompt used to be
 * folded into that turn so the conversation stayed one user turn, and that is
 * the shape this file now exists to keep out. The splitting formatters
 * (openai, litellm, mistral, writer, llamaapi, llamacpp) emit a turn's
 * non-tool content as a user message of its own AHEAD of the tool message its
 * tool results become, so a turn carrying both binds as
 * `assistant(tool_calls) -> user(text) -> tool(result)`. OpenAI answers that
 * with HTTP 400 "An assistant message with 'tool_calls' must be followed by
 * tool messages responding to each 'tool_call_id'", which the bridge reports
 * as a terminal `STRANDS_FORCE_STOP`.
 *
 * When the seed already carries every answer, an unchanged synthetic prompt
 * adds no information. Omit that duplicate: OpenAI gets adjacent tool replies,
 * and Bedrock keeps alternating roles. Actual new questions and application
 * additions still have to reach the model without rewriting earlier questions.
 */

import { describe, it, expect } from "vitest";
import {
  BedrockModel,
  type Message as StrandsMessage,
  type ModelStreamEvent,
} from "@strands-agents/sdk";
import type { BaseEvent } from "@ag-ui/core";
import {
  ScriptedModel,
  collect,
  errorCodes,
  expectCompletedRun,
  expectToolCallsAnsweredImmediately,
  minimalRunInput,
  modelTurn,
  openAIAdjacency,
  openAIBoundMessages,
  realStrandsAgent,
} from "./helpers";

function continuationInput(threadId: string) {
  return minimalRunInput({
    threadId,
    messages: [
      { id: "u1", role: "user", content: "call the tool" } as never,
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "doIt", arguments: "{}" },
          },
        ],
      } as never,
      // Render-only frontend tools legitimately return nothing.
      { id: "t1", role: "tool", toolCallId: "tc1", content: "" } as never,
    ],
    tools: [
      {
        name: "doIt",
        description: "a frontend tool",
        parameters: { type: "object", properties: {} },
      },
    ],
  });
}

/** The content blocks of one message, as the plain serialized form. */
function blocksOf(message: StrandsMessage): Array<Record<string, unknown>> {
  const data = (
    message as unknown as { toJSON?: () => { content?: unknown[] } }
  ).toJSON?.() ?? { content: (message as { content?: unknown[] }).content };
  return (data.content ?? []) as Array<Record<string, unknown>>;
}

function textsOf(message: StrandsMessage): string[] {
  return blocksOf(message)
    .map((block) => block.text)
    .filter((text): text is string => typeof text === "string");
}

function carriesToolResult(message: StrandsMessage): boolean {
  return blocksOf(message).some((block) => block.toolResult !== undefined);
}

/**
 * A model that refuses the shape OpenAI refuses.
 *
 * `ScriptedModel` replays turns whatever it is handed, so on its own it cannot
 * tell a run that would have worked from one OpenAI would have answered with a
 * 400. This double runs the real Chat Completions formatter and rejects a
 * broken tool call the way the provider does, which is what makes the terminal
 * event below mean anything: the bridge turns a throw from the model into a
 * `STRANDS_FORCE_STOP` run error, exactly as it turns the provider's own
 * rejection into one.
 *
 * It deliberately does not enforce role alternation. Two consecutive user
 * turns are a shape this adapter has always produced on its ordinary paths,
 * so a double that refused them would be asserting a fix nothing here makes.
 */
class ProviderRuleModel extends ScriptedModel {
  override async *stream(
    messages: StrandsMessage[],
    options?: { toolSpecs?: { name: string }[] },
  ): AsyncIterable<ModelStreamEvent> {
    const bound = await openAIBoundMessages(messages);
    const adjacency = openAIAdjacency(bound);
    if (adjacency !== "ok") {
      throw new Error(
        "An assistant message with 'tool_calls' must be followed by tool " +
          `messages responding to each 'tool_call_id' (${adjacency})`,
      );
    }
    yield* super.stream(messages, options);
  }
}

describe("cold frontend-tool continuation with replay disabled", () => {
  it.each([
    {
      label: "an empty result",
      result: { content: "" },
      expected: { text: "Tool executed successfully with no return value." },
    },
    {
      label: "a text result",
      result: { content: "approved" },
      expected: { text: "approved" },
    },
    {
      label: "a JSON result",
      result: { content: '{"approved":false}' },
      expected: { json: { approved: false } },
    },
    {
      label: "a failed result",
      result: { content: "", error: "Denied" },
      expected: { text: "Failed: Denied" },
    },
  ])(
    "preserves $label through both provider formatters",
    async ({ result, expected }) => {
      const { agent, model } = realStrandsAgent([modelTurn.text("done")], {
        config: { replayHistoryIntoStrands: false },
      });
      const input = continuationInput("cold-providers");
      input.messages[2] = {
        id: "t1",
        role: "tool",
        toolCallId: "tc1",
        ...result,
      } as never;
      expectCompletedRun(await collect(agent, input));
      expect(model.seenMessages).toHaveLength(1);

      const history = model.seenMessages[0]!;
      expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(textsOf(history[0]!)).toEqual(["call the tool"]);
      expect(textsOf(history[2]!)).toEqual([]);
      expect(blocksOf(history[2]!)).toEqual([
        {
          toolResult: {
            toolUseId: "tc1",
            status: "error" in result ? "error" : "success",
            content: [expected],
          },
        },
      ]);
      expectToolCallsAnsweredImmediately(history);

      const openai = await openAIBoundMessages(history);
      expect(openai.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
      ]);
      expect(openAIAdjacency(openai)).toBe("ok");

      // The SDK's real Converse formatter; no AWS service call is made.
      const bedrock = new BedrockModel({
        modelId: "anthropic.claude-3-haiku-20240307-v1:0",
        clientConfig: { region: "us-east-1" },
      });
      const request = (
        bedrock as unknown as {
          _formatRequest(
            messages: StrandsMessage[],
            options: object,
          ): {
            messages: Array<{ role: string }>;
          };
        }
      )._formatRequest(history, {
        toolSpecs: [
          {
            name: "doIt",
            description: "a frontend tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      expect(request.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
      ]);
    },
  );

  it("keeps a real follow-up question after the tool result", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("done")], {
      config: { replayHistoryIntoStrands: false },
    });
    const input = continuationInput("cold-question");
    input.messages.push({
      id: "u2",
      role: "user",
      content: "Write another haiku.",
    });
    expectCompletedRun(await collect(agent, input));

    const history = model.seenMessages[0]!;
    expect(textsOf(history[0]!)).toEqual(["call the tool"]);
    expect(carriesToolResult(history[2]!)).toBe(true);
    expect(textsOf(history[3]!).join("\n")).toContain("Write another haiku.");
    expect(openAIAdjacency(await openAIBoundMessages(history))).toBe("ok");
  });

  it("keeps additional text supplied by stateContextBuilder", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("done")], {
      config: {
        replayHistoryIntoStrands: false,
        stateContextBuilder: (_input, prompt) =>
          `${prompt}\nUse a formal tone.`,
      },
    });
    expectCompletedRun(await collect(agent, continuationInput("cold-builder")));
    const history = model.seenMessages[0]!;
    expect(textsOf(history[0]!)).toEqual(["call the tool"]);
    expect(textsOf(history[3]!)).toEqual([
      "doIt executed successfully with no return value.\nUse a formal tone.",
    ]);
    expect(openAIAdjacency(await openAIBoundMessages(history))).toBe("ok");
  });

  it("still supplies application context when the duplicate is omitted", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("done")], {
      config: { replayHistoryIntoStrands: false },
    });
    const input = continuationInput("cold-context");
    input.context = [{ description: "preferred tone", value: "formal" }];
    expectCompletedRun(await collect(agent, input));
    const history = model.seenMessages[0]!;
    expect(history).toHaveLength(3);
    expect(textsOf(history[0]!).join("\n")).toContain("formal");
    expect(textsOf(history[0]!).join("\n")).toContain("call the tool");
    expect(textsOf(history[2]!)).toEqual([]);
    expect(openAIAdjacency(await openAIBoundMessages(history))).toBe("ok");
  });

  it("still sends a client answer when warm history only has a placeholder", async () => {
    const { agent, model } = realStrandsAgent(
      [
        modelTurn.toolUse({ toolUseId: "tc1", name: "doIt", input: {} }),
        modelTurn.text("done"),
      ],
      { config: { replayHistoryIntoStrands: false } },
    );
    const first = continuationInput("warm-placeholder");
    first.messages = first.messages.slice(0, 1);
    expectCompletedRun(await collect(agent, first));

    const next = continuationInput(first.threadId);
    next.runId = "run-2";
    next.messages[2] = {
      id: "t1",
      role: "tool",
      toolCallId: "tc1",
      content: '{"approved":false}',
    };
    expectCompletedRun(await collect(agent, next));
    expect(model.seenMessages).toHaveLength(2);
    const history = model.seenMessages[1]!;
    expect(history.flatMap(textsOf).join("\n")).toContain(
      'doIt returned: {"approved":false}',
    );
  });
  it("finishes the run under a model that enforces the provider rules", async () => {
    const { agent } = realStrandsAgent([modelTurn.text("done")], {
      config: { replayHistoryIntoStrands: false },
      model: new ProviderRuleModel([modelTurn.text("done")]),
    });

    const events = await collect(agent, continuationInput("cold-rules"));

    expectCompletedRun(events);
    expect(errorCodes(events)).toEqual([]);
  });

  it("never seeds a blank block for an empty tool result", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("done")], {
      config: { replayHistoryIntoStrands: false },
    });

    const events: BaseEvent[] = [];
    for await (const e of agent.run(continuationInput("cold-2"))) {
      events.push(e);
    }
    expectCompletedRun(events);

    // A render-only tool's empty result must reach the provider as the
    // non-empty acknowledgement the replay path already substitutes, not as
    // the blank text block the provider rejects.
    const serialised = JSON.stringify(
      model.seenMessages[0]!.map(
        (m) => (m as unknown as { toJSON?: () => unknown }).toJSON?.() ?? m,
      ),
    );
    expect(serialised).not.toContain('"text":""');
  });
});
