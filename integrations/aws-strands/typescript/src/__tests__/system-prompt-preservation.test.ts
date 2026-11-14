import { describe, expect, it } from "vitest";
import {
  Agent,
  CachePointBlock,
  GuardContentBlock,
  TextBlock,
  type AgentConfig,
  type SystemContentBlock,
  type SystemPromptData,
} from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import { collect, minimalRunInput, threadAgent } from "./helpers";
import { ScriptedModel } from "./strands-sdk-harness";

function blocks(): SystemContentBlock[] {
  return [
    new TextBlock("Static instructions."),
    new CachePointBlock({ cacheType: "default" }),
    new TextBlock("Dynamic context."),
    new GuardContentBlock({
      text: { text: "Guarded text", qualifiers: ["guard_content"] },
    }),
    new GuardContentBlock({
      image: { format: "png", source: { bytes: new Uint8Array([1, 2, 3]) } },
    }),
  ];
}

function setup(systemPrompt: AgentConfig["systemPrompt"]) {
  const model = new ScriptedModel([
    { kind: "text", text: "first" },
    { kind: "text", text: "second" },
    { kind: "text", text: "third" },
  ]);
  const template = new Agent({ model, systemPrompt, printer: false });
  const adapter = new StrandsAgent({ agent: template, name: "test" });
  return { model, template, adapter };
}

async function nativeModelPrompt(systemPrompt: AgentConfig["systemPrompt"]) {
  const model = new ScriptedModel([{ kind: "text", text: "native" }]);
  const agent = new Agent({ model, systemPrompt, printer: false });
  for await (const _event of agent.stream("hi")) {
    // Drain the native stream so its model input is recorded.
  }
  expect(model.callOptions).toHaveLength(1);
  return model.callOptions[0]?.systemPrompt;
}

async function run(adapter: StrandsAgent, threadId = "a") {
  const events = await collect(
    adapter,
    minimalRunInput({
      threadId,
      messages: [{ id: "u", role: "user", content: "hi" }],
    }),
  );
  expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
    false,
  );
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  return threadAgent(adapter, threadId)!;
}

describe("system prompt preservation with the real SDK", () => {
  it("rejects an unknown SDK block instead of dropping its prototype", () => {
    class FutureSystemBlock {
      readonly type = "futureSystemBlock";

      toJSON() {
        return { futureContent: "opaque" };
      }
    }

    // Simulate a newer installed SDK than the one the adapter compiled with.
    const prompt = [new FutureSystemBlock()] as unknown as SystemContentBlock[];
    expect(() => setup(prompt)).toThrowError(
      new TypeError(
        "Unsupported Strands system prompt block type: futureSystemBlock",
      ),
    );
  });

  it("still snapshots plain prompt data from an Agent-like template", async () => {
    const text = { text: "Original instructions" };
    const prompt = [
      text,
      { cachePoint: { cacheType: "default" } },
    ] satisfies SystemPromptData;
    const model = new ScriptedModel([{ kind: "text", text: "ok" }]);
    const template = new Agent({ model, printer: false });
    // Agent-like templates may expose constructor data rather than SDK classes.
    Object.assign(template, { systemPrompt: prompt });
    const adapter = new StrandsAgent({ agent: template, name: "test" });
    text.text = "Changed instructions";
    prompt.push({ text: "Appended block" });

    const thread = await run(adapter);

    const expected = [
      new TextBlock("Original instructions"),
      new CachePointBlock({ cacheType: "default" }),
    ];
    expect(thread.systemPrompt).toEqual(expected);
    expect(model.callOptions[0]?.systemPrompt).toEqual(expected);
  });

  it.each([
    ["omitted", undefined],
    ["empty string", ""],
    ["empty list", []],
    ["plain text", "Plain text"],
    ["text blocks", [{ text: "First" }, { text: "Second" }]],
    [
      "data blocks",
      [{ text: "Static" }, { cachePoint: { cacheType: "default" } }],
    ],
    ["SDK blocks", blocks()],
    ["cache only", [new CachePointBlock({ cacheType: "default" })]],
  ] satisfies [string, AgentConfig["systemPrompt"]][])(
    "preserves %s at the model boundary",
    async (_name, prompt) => {
      const expected = await nativeModelPrompt(prompt);
      const { model, template, adapter } = setup(prompt);
      const thread = await run(adapter);

      // Compare native invocations: newer SDKs clone/serialize prompts in
      // model middleware, beyond the adapter's stored prompt representation.
      expect(model.callOptions[0]?.systemPrompt).toEqual(expected);
      expect(thread.systemPrompt).toEqual(template.systemPrompt);
      expect(thread.model).toBe(model);
      if (Array.isArray(thread.systemPrompt)) {
        // Class methods must survive copying, including guard image encoding.
        expect(JSON.parse(JSON.stringify(thread.systemPrompt))).toEqual(
          JSON.parse(JSON.stringify(template.systemPrompt)),
        );
      }
    },
  );

  it("captures nested values and array membership at wrap time", async () => {
    const expected = await nativeModelPrompt(blocks());
    const { model, template, adapter } = setup(blocks());
    const held = template.systemPrompt as SystemContentBlock[];
    const guard = held[3] as GuardContentBlock;
    guard.text!.text = "changed template";
    guard.text!.qualifiers.push("query");
    (held[4] as GuardContentBlock).image!.source.bytes[0] = 99;
    held.push(new TextBlock("new template block"));
    template.systemPrompt = "replacement template prompt";

    const thread = await run(adapter);

    expect(thread.systemPrompt).toEqual(blocks());
    expect(model.callOptions[0]?.systemPrompt).toEqual(expected);
  });

  it("isolates threads while retaining changes on cached agents", async () => {
    const { model, template, adapter } = setup(blocks());
    const first = await run(adapter, "a");
    const prompt = first.systemPrompt as SystemContentBlock[];
    const bytes = (prompt[4] as GuardContentBlock).image!.source.bytes;
    const templateBytes = (
      (template.systemPrompt as SystemContentBlock[])[4] as GuardContentBlock
    ).image!.source.bytes;
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(bytes).not.toBe(templateBytes);
    (prompt[3] as GuardContentBlock).text!.text = "thread a text";
    (prompt[4] as GuardContentBlock).image!.source.bytes[0] = 99;
    prompt.push(new TextBlock("thread a block"));

    const second = await run(adapter, "b");
    const reused = await run(adapter, "a");

    expect(second.systemPrompt).toEqual(blocks());
    expect(template.systemPrompt).toEqual(blocks());
    expect(reused).toBe(first);
    expect(reused.systemPrompt).toBe(prompt);
    expect((prompt[3] as GuardContentBlock).text!.text).toBe("thread a text");
    expect(first.model).toBe(model);
    expect(second.model).toBe(model);
  });

  it("retains the existing per-thread systemPrompt override", async () => {
    const model = new ScriptedModel([{ kind: "text", text: "ok" }]);
    const adapter = new StrandsAgent({
      agent: new Agent({ model, systemPrompt: blocks(), printer: false }),
      name: "test",
      config: { threadAgentConfig: () => ({ systemPrompt: "override" }) },
    });

    await run(adapter);

    expect(model.callOptions[0]?.systemPrompt).toBe("override");
  });
});
