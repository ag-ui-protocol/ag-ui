/**
 * Multimodal `RunAgentInput.messages[*].content` must be passed to
 * `agent.stream()` as `ContentBlock[]`, not flattened to a text string.
 *
 * The v1.0 Strands SDK's `InvokeArgs` accepts both `string` and
 * `ContentBlock[]`, matching the Python adapter's behavior.
 */

import { describe, it, expect } from "vitest";
import { EventType, type InputContent } from "@ag-ui/core";
import { StrandsAgent } from "../agent";
import { collect, minimalRunInput, scriptedAgent } from "./helpers";

function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

/**
 * Build a stub Strands Agent whose `.stream()` records the arguments it
 * received, alongside whatever history was seeded onto `agent.messages`.
 * History reconciliation (replayHistoryIntoStrands) makes the adapter
 * call `stream(undefined)` and move the payload to `agent.messages`, so
 * tests need to inspect both to see what actually reached the LLM.
 */
function recordingAgent() {
  const calls: { args: unknown; messages: unknown[] }[] = [];
  const stub = scriptedAgent([], {
    messages: [] as never,
    stream: async function* (args: unknown) {
      calls.push({
        args,
        messages: [...(stub as unknown as { messages: unknown[] }).messages],
      });
    } as unknown as import("@strands-agents/sdk").Agent["stream"],
  });
  return { stub, calls };
}

function makeAgent(stub: import("@strands-agents/sdk").Agent): StrandsAgent {
  const sa = new StrandsAgent({ agent: stub, name: "t" });
  const byThread = (sa as unknown as { _agentsByThread: Map<string, unknown> })
    ._agentsByThread;
  byThread.set("thread-1", stub);
  byThread.set("default", stub);
  return sa;
}

describe("multimodal pass-through", () => {
  it("passes ContentBlock[] to agent.stream when the message contains an image", async () => {
    const { stub, calls } = recordingAgent();
    const agent = makeAgent(stub);
    const content: InputContent[] = [
      { type: "text", text: "what is in this image?" },
      {
        type: "image",
        source: {
          type: "data",
          value: b64("fake-png-bytes"),
          mimeType: "image/png",
        },
      },
    ];
    await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content }],
      }),
    );
    expect(calls).toHaveLength(1);
    // Replay routes multimodal content into agent.messages and calls
    // stream(undefined); the `user` turn's content carries a TextBlock +
    // ImageBlock pair (as Strands class instances after Message.fromMessageData).
    expect(calls[0]!.args).toBeUndefined();
    const replayed = calls[0]!.messages as Array<{
      role: string;
      content: Array<{ type: string }>;
    }>;
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.role).toBe("user");
    expect(replayed[0]!.content).toHaveLength(2);
    expect(replayed[0]!.content[0]!.type).toBe("textBlock");
    expect(replayed[0]!.content[1]!.type).toBe("imageBlock");
  });

  it("falls back to text when ALL media blocks fail conversion (unsupported MIME)", async () => {
    const { stub, calls } = recordingAgent();
    const agent = makeAgent(stub);
    const content: InputContent[] = [
      {
        type: "image",
        source: {
          type: "data",
          value: b64("anything"),
          // image/bmp is not in the allowlist — conversion will skip it.
          mimeType: "image/bmp",
        },
      },
    ];
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content }],
      }),
    );
    // No text fallback available — emits MEDIA_RESOLUTION_FAILED error
    // and does not invoke the agent.
    expect(calls).toHaveLength(0);
    const error = events.find((e) => e.type === EventType.RUN_ERROR) as
      | { code: string; message: string }
      | undefined;
    expect(error).toBeTruthy();
    expect(error!.code).toBe("MEDIA_RESOLUTION_FAILED");
  });

  it("preserves ContentBlock[] even when stateContextBuilder is configured", async () => {
    const { stub, calls } = recordingAgent();
    const agent = makeAgent(stub);
    // Install a stateContextBuilder that would wrap text prompts. It MUST NOT
    // be applied to multimodal prompts — the image content would be lost.
    (agent as unknown as { config: Record<string, unknown> }).config = {
      stateContextBuilder: (_input: unknown, prompt: string) =>
        `[STATE: wrapped] ${prompt}`,
    };
    const content: InputContent[] = [
      { type: "text", text: "describe the picture" },
      {
        type: "image",
        source: {
          type: "data",
          value: b64("fake-jpeg"),
          mimeType: "image/jpeg",
        },
      },
    ];
    await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content }],
      }),
    );
    // The builder runs on the replay path's last user-text turn, not on
    // a synthetic prompt — so the multimodal content persists as a proper
    // ContentBlock[] on agent.messages[0].content alongside any wrapped
    // text block. Assert the image survives the builder.
    expect(calls[0]!.args).toBeUndefined();
    const replayed = calls[0]!.messages as Array<{
      role: string;
      content: Array<{ type: string }>;
    }>;
    expect(replayed[0]!.content.some((b) => b.type === "imageBlock")).toBe(
      true,
    );
  });

  it("applies stateContextBuilder to plain-text prompts as before", async () => {
    const { stub, calls } = recordingAgent();
    const agent = makeAgent(stub);
    (agent as unknown as { config: Record<string, unknown> }).config = {
      stateContextBuilder: (_input: unknown, prompt: string) =>
        `${prompt} [STATE: ok]`,
    };
    await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "plain text prompt" }],
      }),
    );
    // Replay routes the prompt into agent.messages[*].content[*].text, with
    // the builder's augmentation applied. The adapter calls stream(undefined).
    expect(calls[0]!.args).toBeUndefined();
    const replayed = calls[0]!.messages as Array<{
      role: string;
      content: Array<{ text?: string }>;
    }>;
    expect(replayed[0]!.content[0]!.text).toBe("plain text prompt [STATE: ok]");
  });
});
