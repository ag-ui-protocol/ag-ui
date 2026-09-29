import { afterEach, vi } from "vitest";
import { Agent } from "@mastra/core/agent";
import { MastraAgent } from "../mastra";
import { EventType, type TextMessageChunkEvent } from "@ag-ui/client";
import {
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
  collectError,
} from "./helpers";

function joinedText(events: Awaited<ReturnType<typeof collectEvents>>): string {
  return events
    .filter(
      (e): e is TextMessageChunkEvent =>
        e.type === EventType.TEXT_MESSAGE_CHUNK,
    )
    .map((e) => e.delta ?? "")
    .join("");
}

/**
 * A Mastra input/output processor that aborts the run emits a `tripwire`
 * chunk and closes the stream. Without a mapping the client saw
 * RUN_STARTED … RUN_FINISHED with no output at all.
 */
describe("tripwire chunks", () => {
  afterEach(() => vi.restoreAllMocks());
  it("surfaces a blocking tripwire as assistant text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tripwire",
          payload: {
            reason: "Prompt injection detected",
            processorId: "guard",
          },
        },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    expect(joinedText(events)).toBe("Prompt injection detected");
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes("Unrecognized stream chunk type"),
      ),
    ).toBe(false);
    warn.mockRestore();
  });

  it("suppresses a retry reason when a subsequent answer arrives", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "text-delta", payload: { text: "first try" } },
        { type: "tripwire", payload: { reason: "Too long", retry: true } },
        { type: "text-delta", payload: { text: "second try" } },
        { type: "finish", payload: { finishReason: "stop" } },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    expect(joinedText(events)).toBe("first trysecond try");
    expect(joinedText(events)).not.toContain("Too long");
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes("Unrecognized stream chunk type"),
      ),
    ).toBe(false);
    warn.mockRestore();
  });
});

describe.each([
  ["local", makeLocalMastraAgent],
  ["remote", makeRemoteMastraAgent],
] as const)("%s terminal retry tripwires", (_kind, makeAgent) => {
  it.each([false, true])(
    "surfaces the reason at EOF with buffering=%s",
    async (useProcessedFinalText) => {
      const agent = makeAgent({
        useProcessedFinalText,
        streamChunks: [
          { type: "text-delta", payload: { text: "Rejected text" } },
          { type: "tripwire", payload: { reason: "Try again", retry: true } },
          { type: "step-start", payload: {} },
        ],
      });
      const events = await collectEvents(agent, makeInput());
      expect(joinedText(events)).toBe(
        useProcessedFinalText ? "Try again" : "Rejected textTry again",
      );
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    },
  );

  it("discards rejected buffered text when a retry succeeds", async () => {
    const agent = makeAgent({
      useProcessedFinalText: true,
      streamChunks: [
        { type: "text-delta", payload: { text: "Rejected text" } },
        { type: "tripwire", payload: { reason: "Try again", retry: true } },
        { type: "text-delta", payload: { text: "Accepted text" } },
        { type: "finish", payload: {} },
      ],
    });
    expect(joinedText(await collectEvents(agent, makeInput()))).toBe(
      "Accepted text",
    );
  });

  it("accepts processed final text without replaying the retry reason", async () => {
    const agent = makeAgent({
      useProcessedFinalText: true,
      streamChunks: [
        { type: "tripwire", payload: { reason: "Try again", retry: true } },
        {
          type: "finish",
          payload: {
            response: {
              uiMessages: [{ role: "assistant", content: "Accepted" }],
            },
          },
        },
      ],
    });
    expect(joinedText(await collectEvents(agent, makeInput()))).toBe(
      "Accepted",
    );
  });

  it("accepts a tool response without replaying the retry reason", async () => {
    const agent = makeAgent({
      streamChunks: [
        { type: "tripwire", payload: { reason: "Try again", retry: true } },
        {
          type: "tool-call",
          payload: { toolCallId: "tc-1", toolName: "lookup", args: {} },
        },
        {
          type: "tool-result",
          payload: { toolCallId: "tc-1", toolName: "lookup", result: "Found" },
        },
      ],
    });
    const events = await collectEvents(agent, makeInput());
    expect(joinedText(events)).toBe("");
    expect(events.some((e) => e.type === EventType.TOOL_CALL_RESULT)).toBe(
      true,
    );
  });

  it("does not replay a pending reason after a stream error", async () => {
    const agent = makeAgent({
      streamChunks: [
        { type: "tripwire", payload: { reason: "Try again", retry: true } },
        { type: "error", payload: { error: "Stream failed" } },
      ],
    });
    const { events, error } = await collectError(agent, makeInput());
    expect(error.message).toContain("Stream failed");
    expect(joinedText(events)).toBe("");
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(false);
  });

  it("does not suppress a terminal tripwire after an earlier retry answer", async () => {
    const agent = makeAgent({
      streamChunks: [
        {
          type: "tripwire",
          payload: { reason: "First rejection", retry: true },
        },
        { type: "text-delta", payload: { text: "Retry answer" } },
        {
          type: "tripwire",
          payload: { reason: "Final rejection", retry: true },
        },
      ],
    });
    expect(joinedText(await collectEvents(agent, makeInput()))).toBe(
      "Retry answerFinal rejection",
    );
  });
});

it("surfaces a real Mastra input processor's terminal retry request", async () => {
  const unexpectedModelCall = vi.fn(async () => {
    throw new Error("Input processor must block before model execution");
  });
  const agent = new Agent({
    id: "tripwire-test",
    name: "tripwire-test",
    instructions: "Test processor aborts",
    model: {
      specificationVersion: "v2",
      provider: "test",
      modelId: "test",
      supportedUrls: {},
      doGenerate: unexpectedModelCall,
      doStream: unexpectedModelCall,
    },
    inputProcessors: [
      {
        id: "guard",
        processInput: ({ abort }) => abort("Blocked input", { retry: true }),
      },
    ],
  });
  const bridge = new MastraAgent({
    agentId: "tripwire-test",
    agent,
    resourceId: "resource-1",
  });
  const events = await collectEvents(bridge, makeInput());
  expect(joinedText(events)).toBe("Blocked input");
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  expect(unexpectedModelCall).not.toHaveBeenCalled();
});
