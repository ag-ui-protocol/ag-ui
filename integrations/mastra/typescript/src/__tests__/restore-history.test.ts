import type { Message } from "@ag-ui/client";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { MockMemory } from "@mastra/core/memory";
import { InMemoryStore } from "@mastra/core/storage";
import { createTool } from "@mastra/core/tools";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MastraAgent } from "../mastra";
import { convertMastraMessagesToAGUI } from "../utils";
import { collectEvents, makeInput } from "./helpers";

const finish = (finishReason: "stop" | "tool-calls") => ({
  type: "finish" as const,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  finishReason,
});

/** A model that answers each call with the next scripted chunk list. */
function scriptedModel(turns: any[][], prompts: unknown[]) {
  let call = 0;
  return new MastraLanguageModelV2Mock({
    doStream: async ({ prompt }: { prompt: unknown }) => {
      prompts.push(prompt);
      const chunks = turns[call++] ?? [];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        request: { body: {} },
        response: undefined,
      };
    },
  });
}

describe("restoring stored history with convertMastraMessagesToAGUI", () => {
  it("does not persist restored history a second time on the next run", async () => {
    const prompts: unknown[] = [];
    const model = scriptedModel(
      [
        // Run 1, step 1: text, then a server tool call.
        [
          { type: "text-delta" as const, id: "t1", delta: "Let me check." },
          {
            type: "tool-call" as const,
            toolCallId: "call_1",
            toolName: "getWeather",
            input: JSON.stringify({ city: "Lisbon" }),
          },
          finish("tool-calls"),
        ],
        // Run 1, step 2: text after the tool result.
        [
          { type: "text-delta" as const, id: "t2", delta: "It is 19C." },
          finish("stop"),
        ],
        // Run 2: the answer to the new user message.
        [
          { type: "text-delta" as const, id: "t3", delta: "You are welcome." },
          finish("stop"),
        ],
      ],
      prompts,
    );
    const getWeather = createTool({
      id: "getWeather",
      description: "Weather for a city",
      inputSchema: z.object({ city: z.string() }),
      execute: async () => ({ tempC: 19 }),
    });
    const mastra = new Mastra({
      agents: {
        weather: new Agent({
          id: "weather-agent",
          name: "weather-agent",
          instructions: "Answer weather questions.",
          model: model as any,
          tools: { getWeather },
          memory: new MockMemory() as any,
        }),
      },
      storage: new InMemoryStore(),
      logger: false,
    });
    const agent = mastra.getAgent("weather");
    const bridge = () =>
      new MastraAgent({ agentId: "weather-agent", agent, resourceId: "r1" });
    const recall = async () => {
      const memory = await agent.getMemory();
      const { messages } = await memory!.recall({
        threadId: "thread-1",
        resourceId: "r1",
        perPage: false,
      });
      return messages;
    };

    const user1 = { id: "u1", role: "user", content: "Weather in Lisbon?" };
    await collectEvents(
      bridge(),
      makeInput({ runId: "run-1", messages: [user1] as Message[] }),
    );
    const storedAfterRun1 = await recall();
    expect(storedAfterRun1.length).toBeGreaterThan(0);

    // A page reload: the client has nothing but what Mastra stored.
    const restored = convertMastraMessagesToAGUI(storedAfterRun1);
    expect(restored.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);

    const user2 = { id: "u2", role: "user", content: "Thanks!" };
    await collectEvents(
      bridge(),
      makeInput({
        runId: "run-2",
        messages: [...restored, user2] as Message[],
      }),
    );
    const storedAfterRun2 = await recall();

    // Every row from run 1 is still there exactly once, and run 2 added only
    // its own user message and reply.
    const ids = storedAfterRun2.map((m: any) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { id } of storedAfterRun1) expect(ids).toContain(id);
    expect(storedAfterRun2).toHaveLength(storedAfterRun1.length + 2);

    // The model saw the restored turn once, not twice.
    const lastPrompt = JSON.stringify(prompts.at(-1));
    expect(lastPrompt.split("It is 19C.")).toHaveLength(2);
    expect(lastPrompt.split('"call_1"').length).toBeLessThanOrEqual(3);
  });
});
