import { describe, expect, it, vi } from "vitest";
import { EventType, type RunFinishedEvent } from "@ag-ui/client";
import { MastraClient } from "@mastra/client-js";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { MockMemory } from "@mastra/core/memory";
import { RequestContext } from "@mastra/core/request-context";
import type { ContextWithMastra } from "@mastra/core/server";
import { InMemoryStore } from "@mastra/core/storage";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as bridge from "../index";
import {
  mastraRunGuidanceProcessor,
  registerMastraRunGuidanceCapabilities,
  withMastraRunGuidanceAuthority,
} from "../run-guidance-native";
import { collectEvents, makeInput } from "./helpers";

const declaration = { "openbot.runGuidance": { version: 1 } };

function context(role: string, tools?: string) {
  return [
    { description: "OpenBot standing role", value: role },
    ...(tools
      ? [{ description: "OpenBot granted tools guidance", value: tools }]
      : []),
  ];
}

const user = { role: "user" as const, id: "user-1", content: "File my dinner" };

function receiver({
  configured = false,
  suspend = false,
  followUp = false,
  customInstructions = false,
} = {}) {
  const prompts: { role: string; content: unknown }[][] = [];
  const model = new MastraLanguageModelV2Mock({
    doStream: async ({ prompt }: { prompt: (typeof prompts)[number] }) => {
      prompts.push(prompt);
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      const initial = (suspend || followUp) && prompts.length === 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue(
              initial
                ? {
                    type: "tool-call",
                    toolCallId: "tc-1",
                    toolName: "approve",
                    input: "{}",
                  }
                : { type: "text-delta", id: "t1", delta: "Filed." },
            );
            controller.enqueue({
              type: "finish",
              usage,
              finishReason: initial ? "tool-calls" : "stop",
            });
            controller.close();
          },
        }),
        request: { body: {} },
        response: undefined,
      };
    },
  });
  const approve = createTool({
    id: "approve",
    description: "Pause for approval",
    inputSchema: z.object({}),
    suspendSchema: z.object({ message: z.string() }),
    execute: async (_input, ctx) =>
      !suspend || ctx?.agent?.resumeData
        ? { filed: true }
        : ctx?.agent?.suspend({ message: "Approve?" }),
  });
  const memory = new MockMemory();
  const agent = new Agent({
    id: "test",
    name: "test",
    instructions: customInstructions
      ? ({ requestContext }) => {
          const entry = requestContext.get("ag-ui") as
            | { context: { value: string }[] }
            | undefined;
          return `Base instructions ${entry?.context.map(({ value }) => value).join(", ")}`;
        }
      : "Base instructions",
    model: model as any,
    memory: memory as any,
    ...(configured ? { inputProcessors: [mastraRunGuidanceProcessor] } : {}),
    ...(suspend || followUp ? { tools: { approve } } : {}),
  });
  const mastra = new Mastra({
    agents: { test: agent },
    storage: new InMemoryStore(),
    logger: false,
  });
  return { agent, mastra, memory, prompts };
}

function occurrences(
  prompt: { role: string; content: unknown }[],
  role: string,
  value: string,
) {
  return prompt.filter(
    (message) =>
      message.role === role && JSON.stringify(message.content).includes(value),
  ).length;
}

describe("Mastra run guidance", () => {
  it("adds trusted guidance once at the provider boundary, and replaces and clears each run", async () => {
    const { agent, memory, prompts } = receiver();
    const wrapped = new bridge.MastraAgent({
      agent,
      agentId: "test",
      resourceId: "resource",
      runGuidance: { trusted: true },
    });
    expect((await wrapped.getCapabilities()).custom).toEqual(declaration);
    const first = makeInput({
      messages: [user],
      context: context("role-A", "tools-A"),
    });
    await collectEvents(wrapped, first);
    await collectEvents(
      wrapped,
      makeInput({ ...first, runId: "run-2", context: context("role-B") }),
    );
    await collectEvents(
      wrapped,
      makeInput({ ...first, runId: "run-3", context: [] }),
    );

    expect(occurrences(prompts[0], "system", "Base instructions")).toBe(1);
    expect(occurrences(prompts[0], "system", "role-A")).toBe(1);
    expect(occurrences(prompts[0], "system", "tools-A")).toBe(1);
    expect(occurrences(prompts[1], "system", "role-B")).toBe(1);
    expect(JSON.stringify(prompts[1])).not.toMatch(/role-A|tools-A/);
    expect(JSON.stringify(prompts[2])).not.toMatch(/role-A|role-B|tools-A/);
    const stored = await memory.recall({
      threadId: first.threadId,
      resourceId: "resource",
    });
    expect(JSON.stringify(stored.messages)).not.toMatch(
      /role-A|role-B|tools-A/,
    );
  });

  it("keeps anonymous guidance in user context in the standard local factory", async () => {
    const { mastra, prompts } = receiver({ customInstructions: true });
    const wrapped = bridge.MastraAgent.getLocalAgents({
      mastra,
      resourceId: "resource",
      runGuidance: {},
    }).test as bridge.MastraAgent;
    const input = makeInput({
      messages: [user],
      context: [
        ...context("role-A", "tools-A"),
        { description: "other", value: "ordinary custom context" },
      ],
      forwardedProps: { trusted: true },
    });
    wrapped.headers = { "x-forwarded-for": "127.0.0.1", "x-trusted": "true" };
    await withMastraRunGuidanceAuthority(true, () =>
      collectEvents(wrapped, input),
    );

    expect((await wrapped.getCapabilities()).custom).toEqual(declaration);
    expect(occurrences(prompts[0], "system", "ordinary custom context")).toBe(
      1,
    );
    expect(occurrences(prompts[0], "user", "role-A")).toBe(1);
    expect(occurrences(prompts[0], "system", "role-A")).toBe(0);
    expect(JSON.stringify(prompts[0])).not.toContain("tools-A");
  });

  it("applies guidance once to each model call after a server tool executes", async () => {
    const { agent, prompts } = receiver({ followUp: true });
    const wrapped = new bridge.MastraAgent({
      agent,
      agentId: "test",
      runGuidance: { trusted: true },
    });
    await collectEvents(
      wrapped,
      makeInput({ messages: [user], context: context("role-A", "tools-A") }),
    );
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(occurrences(prompt, "system", "role-A")).toBe(1);
      expect(occurrences(prompt, "system", "tools-A")).toBe(1);
    }
  });

  it("deduplicates the packaged processor when the underlying agent already uses it", async () => {
    const { agent, prompts } = receiver({ configured: true });
    const wrapped = new bridge.MastraAgent({
      agent,
      agentId: "test",
      runGuidance: { trusted: true },
    });
    await collectEvents(
      wrapped,
      makeInput({ messages: [user], context: context("role-A") }),
    );
    expect(occurrences(prompts[0], "system", "role-A")).toBe(1);
  });

  it("keeps legacy local agents compatible and omits the declaration without the provider hook", async () => {
    const { agent } = receiver();
    const legacy = new bridge.MastraAgent({ agent, agentId: "test" });
    expect((await legacy.getCapabilities()).custom).toBeUndefined();

    Object.defineProperty(agent, "listResolvedLLMRequestProcessors", {
      value: undefined,
    });
    const configured = new bridge.MastraAgent({
      agent,
      agentId: "test",
      runGuidance: {},
    });
    expect((await configured.getCapabilities()).custom).toBeUndefined();
  });

  it.each([false, true])(
    "reads fresh guidance after Mastra suspend/resume (native processor configured=%s)",
    async (configured) => {
      const { agent, prompts } = receiver({ suspend: true, configured });
      const wrapped = new bridge.MastraAgent({
        agent,
        agentId: "test",
        resourceId: "resource",
        ...(configured ? {} : { runGuidance: { trusted: true } }),
      });
      const run = (input: ReturnType<typeof makeInput>) =>
        withMastraRunGuidanceAuthority(true, () =>
          collectEvents(wrapped, input),
        );
      const first = await run(
        makeInput({ messages: [user], context: context("role-A", "tools-A") }),
      );
      const finished = first.find(
        (event): event is RunFinishedEvent =>
          event.type === EventType.RUN_FINISHED,
      );
      if (finished?.outcome?.type !== "interrupt")
        throw new Error("Expected a suspended tool");
      await run(
        makeInput({
          runId: "run-2",
          context: context("role-B"),
          resume: [
            {
              interruptId: finished.outcome.interrupts[0].id,
              status: "resolved",
              payload: true,
            },
          ],
        }),
      );
      expect(occurrences(prompts[1], "system", "role-B")).toBe(1);
      expect(JSON.stringify(prompts[1])).not.toMatch(/role-A|tools-A/);
    },
  );

  it.each([false, true])(
    "declares native run guidance only when the processor is configured (%s)",
    async (configured) => {
      const { mastra } = receiver({ configured });
      const route = registerMastraRunGuidanceCapabilities("test");
      expect(route.path).toBe("/test/capabilities");
      expect(route.method).toBe("GET");
      const requestContext = new RequestContext();
      const { handler } = route as unknown as {
        handler: (context: ContextWithMastra) => Promise<Response>;
      };
      const result = await handler({
        get: (key: string) => (key === "mastra" ? mastra : requestContext),
        json: Response.json,
      } as unknown as ContextWithMastra);
      expect(await (result as Response).json()).toEqual(
        configured ? { custom: declaration } : {},
      );
    },
  );

  it("discovers native capabilities using the configured client transport and the agent's native ID", async () => {
    const dial = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/native/agents")
        ? Response.json({ "test agent": {} })
        : Response.json({ custom: declaration }),
    );
    const client = new MastraClient({
      baseUrl: "https://mastra.example/gateway/",
      apiPrefix: "/native",
      fetch: dial,
      headers: { authorization: "Bearer bot-key" },
      credentials: "include",
    });
    const agents = await bridge.MastraAgent.getRemoteAgents({
      mastraClient: client,
      resourceId: "resource",
    });
    const wrapped = agents["test agent"] as bridge.MastraAgent;
    wrapped.agentId = "public-alias";
    wrapped.headers = { authorization: "Bearer unrelated-user" };

    expect((await wrapped.getCapabilities()).custom).toEqual(declaration);
    expect(dial).toHaveBeenLastCalledWith(
      "https://mastra.example/gateway/test%20agent/capabilities",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer bot-key" },
        credentials: "include",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([
    () => Response.json({ identity: "malformed", custom: declaration }),
    () => new Response(null, { status: 404 }),
    () =>
      Response.json({ custom: { "openbot.runGuidance": { version: "1" } } }),
    () => new Response("not JSON"),
  ])(
    "omits native run guidance for a missing or invalid declaration",
    async (response) => {
      const dial = vi.fn<typeof fetch>(async () => response());
      const client = new MastraClient({
        baseUrl: "https://mastra.example",
        fetch: dial,
      });
      const wrapped = new bridge.MastraAgent({
        agentId: "test",
        agent: client.getAgent("test"),
      });
      expect((await wrapped.getCapabilities()).custom).toBeUndefined();
      expect(dial).toHaveBeenCalledOnce();
    },
  );
});
