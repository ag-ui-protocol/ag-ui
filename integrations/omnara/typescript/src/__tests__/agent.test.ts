import { describe, expect, it, vi } from "vitest";
import type { BaseEvent, Message, Tool } from "@ag-ui/core";
import { OmnaraAgent } from "../agent";
import type { OmnaraAgentConfig } from "../types";
import { FakeApiError, FakeOmnara } from "./fake-omnara";

const BACKGROUND: Tool = {
  name: "change_background",
  description: "Change the background.",
  parameters: { type: "object", properties: { color: { type: "string" } } },
};

function setup(extra: Partial<OmnaraAgentConfig> = {}) {
  const fake = new FakeOmnara();
  const onError = vi.fn();
  const agent = new OmnaraAgent(
    {
      orgId: "org",
      projectId: "proj",
      definition: { source: "version: v1" },
      user: { id: "u1", name: "Ada" },
      onError,
      ...extra,
    },
    fake,
  );
  agent.threadId = "thread-1";
  return { fake, agent, onError };
}

/** Runs through the real client pipeline (verification included); returns the events. */
async function run(
  agent: OmnaraAgent,
  input: {
    text?: string;
    tools?: Tool[];
    resume?: unknown[];
    context?: unknown[];
    messages?: Message[];
  } = {},
) {
  if (input.text)
    agent.addMessage({
      id: `u-${agent.messages.length}`,
      role: "user",
      content: input.text,
    });
  for (const m of input.messages ?? []) agent.addMessage(m);
  const events: BaseEvent[] = [];
  await agent.runAgent(
    {
      tools: input.tools ?? [],
      context: input.context ?? [],
      ...(input.resume ? { resume: input.resume } : {}),
    } as never,
    { onEvent: ({ event }) => void events.push(event) },
  );
  return events;
}

const finished = (events: BaseEvent[]) =>
  events.find((e) => e.type === "RUN_FINISHED") as unknown as
    | { outcome: Record<string, unknown> }
    | undefined;
const errored = (events: BaseEvent[]) =>
  events.find((e) => e.type === "RUN_ERROR") as unknown as
    | { code: string; message: string }
    | undefined;
const pendingId = (events: BaseEvent[]) =>
  (finished(events)?.outcome as { pendingToolCallIds: string[] })
    .pendingToolCallIds[0]!;
const MCC = expect.stringMatching(/^mcc_/);
const summary = (messages: Message[]) =>
  messages.map((m) => {
    const x = m as Message & {
      content?: unknown;
      toolCalls?: Array<{ id: string }>;
      toolCallId?: string;
    };
    return [
      m.role,
      m.id,
      typeof x.content === "string" ? x.content : undefined,
      x.toolCalls?.map((c) => c.id) ?? x.toolCallId,
    ];
  });

/** The agent answers each message with one streamed reply. */
function replies(fake: FakeOmnara, text = "Hi there") {
  fake.onInput = () => {
    const mcc = fake.id("mcc");
    fake.delta(mcc, 1, {
      kind: "block_start",
      block_index: 0,
      block: { kind: "text" },
    });
    fake.delta(mcc, 2, {
      kind: "text_delta",
      block_index: 0,
      delta: text.slice(0, 3),
    });
    fake.delta(mcc, 3, {
      kind: "text_delta",
      block_index: 0,
      delta: text.slice(3),
    });
    fake.delta(mcc, 4, { kind: "block_stop", block_index: 0 });
    fake.output(mcc, [{ type: "text", text }]);
  };
}

describe("chat", () => {
  it("streams a reply and ends with history whose ids match what was streamed", async () => {
    const { fake, agent } = setup();
    replies(fake);
    const events = await run(agent, { text: "hello" });

    expect(events[0]).toMatchObject({
      type: "RUN_STARTED",
      protocolVersion: "1.0",
    });
    expect(events.find((e) => e.type === "CUSTOM")).toMatchObject({
      name: "omnara.agent",
      value: { agentId: "agt_1" },
    });
    expect(finished(events)?.outcome).toEqual({ type: "success" });
    expect(summary(agent.messages)).toEqual([
      ["user", "u-0", "hello", undefined],
      ["assistant", MCC, "Hi there", undefined],
    ]);
    expect(events.find((e) => e.type === "TEXT_MESSAGE_START")).toMatchObject({
      messageId: agent.messages[1]!.id,
    });
    const [, body, key] = fake.called("postInput")[0] as [
      string,
      { actor: unknown },
      string,
    ];
    expect(key).toBe("agui:u-0");
    expect(body.actor).toEqual({ provider_user_id: "u1", display_name: "Ada" });
  });

  it("uses the same agent for a thread, and never resends a message Omnara has", async () => {
    const { fake, agent } = setup();
    replies(fake);
    await run(agent, { text: "one" });
    await run(agent, { text: "two" });
    const keys = fake.called("launch").map((args) => args[1]);
    expect(new Set(keys).size).toBe(1);
    expect(fake.called("postInput").map((args) => args[2])).toEqual([
      "agui:u-0",
      "agui:u-2",
    ]);
  });

  it("keys the agent by user and thread, so each gets its own agent", async () => {
    const a = setup({ user: { id: "u1" } });
    const b = setup({ user: { id: "u2" } });
    const c = setup({ user: { id: "u1" } });
    c.agent.threadId = "thread-2";
    for (const { fake, agent } of [a, b, c]) {
      replies(fake);
      await run(agent, { text: "x" });
    }
    const keys = [a, b, c].map(({ fake }) => fake.called("launch")[0]![1]);
    expect(new Set(keys).size).toBe(3);
  });

  it("replaces a failed preview with the recorded reply", async () => {
    const { fake, agent } = setup();
    fake.onInput = () => {
      fake.delta("mcc_a", 1, {
        kind: "block_start",
        block_index: 0,
        block: { kind: "text" },
      });
      fake.delta("mcc_a", 2, {
        kind: "text_delta",
        block_index: 0,
        delta: "Partial ans",
      });
      fake.delta("mcc_a", 3, { kind: "error", error: { message: "boom" } });
      fake.output("mcc_b", [{ type: "text", text: "Full answer" }]);
    };
    await run(agent, { text: "q" });
    expect(summary(agent.messages)).toEqual([
      ["user", "u-0", "q", undefined],
      ["assistant", "mcc_b", "Full answer", undefined],
    ]);
  });

  it("previews reasoning and keeps it once, under the same id", async () => {
    const { fake, agent } = setup();
    fake.onInput = () => {
      fake.delta("mcc_r", 1, {
        kind: "block_start",
        block_index: 0,
        block: { kind: "thinking" },
      });
      fake.delta("mcc_r", 2, {
        kind: "thinking_delta",
        block_index: 0,
        delta: "Hmm",
      });
      fake.delta("mcc_r", 3, { kind: "block_stop", block_index: 0 });
      fake.output("mcc_r", [
        { type: "reasoning", text: "Hmm" },
        { type: "text", text: "Answer" },
      ]);
    };
    const events = await run(agent, { text: "q" });
    expect(
      events.find((e) => e.type === "REASONING_MESSAGE_START"),
    ).toMatchObject({ messageId: "mcc_r:block:0" });
    expect(summary(agent.messages)).toEqual([
      ["user", "u-0", "q", undefined],
      ["reasoning", "mcc_r:block:0", "Hmm", undefined],
      ["assistant", "mcc_r", "Answer", undefined],
    ]);
  });

  it("shows no reasoning for a thinking block that streams no text", async () => {
    const { fake, agent } = setup();
    // OpenAI reasoning without summaries: an empty block, then the answer.
    fake.onInput = () => {
      fake.delta("mcc_r", 1, {
        kind: "block_start",
        block_index: 0,
        block: { kind: "thinking" },
      });
      fake.delta("mcc_r", 2, { kind: "block_stop", block_index: 0 });
      fake.delta("mcc_r", 3, {
        kind: "block_start",
        block_index: 1,
        block: { kind: "text" },
      });
      fake.delta("mcc_r", 4, {
        kind: "text_delta",
        block_index: 1,
        delta: "Answer",
      });
      fake.delta("mcc_r", 5, { kind: "block_stop", block_index: 1 });
      fake.output("mcc_r", [{ type: "text", text: "Answer" }]);
    };
    const events = await run(agent, { text: "q" });
    expect(events.some((e) => e.type.startsWith("REASONING"))).toBe(false);
    expect(summary(agent.messages)).toEqual([
      ["user", "u-0", "q", undefined],
      ["assistant", "mcc_r", "Answer", undefined],
    ]);
  });

  it("puts app context on the message as a hidden block", async () => {
    const { fake, agent } = setup();
    replies(fake);
    await run(agent, {
      text: "hi",
      context: [{ description: "Page", value: "Billing" }],
    });
    const [, body] = fake.called("postInput")[0] as [
      string,
      { content_blocks: Array<Record<string, unknown>> },
    ];
    expect(body.content_blocks).toEqual([
      { type: "text", text: "hi" },
      {
        type: "text",
        text: "Context from the app:\n- Page: Billing",
        metadata: { omnara_hidden: "true" },
      },
    ]);
    expect(summary(agent.messages)[0]).toEqual([
      "user",
      "u-0",
      "hi",
      undefined,
    ]);
  });

  it("forwards inline images and notes what it can't forward", async () => {
    const { fake, agent } = setup();
    replies(fake);
    await run(agent, {
      messages: [
        {
          id: "u-0",
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image",
              source: { type: "data", value: "AAAA", mimeType: "image/png" },
            },
            {
              type: "audio",
              source: { type: "data", value: "AAAA", mimeType: "audio/wav" },
            },
          ],
        },
      ],
    });
    const [, body] = fake.called("postInput")[0] as [
      string,
      { content_blocks: Array<Record<string, unknown>> },
    ];
    expect(body.content_blocks).toEqual([
      { type: "text", text: "look" },
      { type: "media", media_type: "image/png", data: "AAAA" },
      {
        type: "text",
        text: "(The user attached a file (audio) that could not be forwarded.)",
        metadata: { omnara_hidden: "true" },
      },
    ]);
  });

  it("resends a message without attachments Omnara rejects", async () => {
    const { fake, agent, onError } = setup();
    replies(fake);
    fake.failNext.set("postInput", 400);
    const events = await run(agent, {
      messages: [
        {
          id: "u-0",
          role: "user",
          content: [
            { type: "text", text: "see" },
            {
              type: "image",
              source: { type: "data", value: "AAAA", mimeType: "image/bmp" },
            },
          ],
        },
      ],
    });
    expect(finished(events)?.outcome).toEqual({ type: "success" });
    const second = fake.called("postInput")[1] as [
      string,
      { content_blocks: Array<{ type: string }> },
    ];
    expect(second[1].content_blocks.map((b) => b.type)).toEqual([
      "text",
      "text",
    ]);
    expect(onError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: "attachment_rejected" }),
    );
  });

  it("marks files in tool results and in other people's messages with [file]", async () => {
    const { fake, agent } = setup();
    fake.onInput = () => {
      fake.output(
        "mcc_u",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_up",
            tool_type: "built_in",
            name: "upload_file",
            input: {},
          },
        ],
        "tool_use",
      );
      fake.push({
        event_kind: "tool_result",
        tool_call_id: "tcl_up",
        outcome: "succeeded",
        content_blocks: [
          { type: "structured_data", value: { path: "/artifacts/art_1" } },
          { type: "media_ref", artifact_id: "art_1" },
        ],
      });
      fake.output("mcc_done", [{ type: "text", text: "Uploaded." }]);
    };
    const events = await run(agent, { text: "make a chart" });
    expect(events.find((e) => e.type === "TOOL_CALL_RESULT")).toMatchObject({
      content: '{"path":"/artifacts/art_1"}\n[file]',
    });
    expect(agent.messages.find((m) => m.role === "tool")).toMatchObject({
      content: '{"path":"/artifacts/art_1"}\n[file]',
    });

    fake.actors.set("actr_dana", {
      provider: "external",
      display_name: "Dana",
      provider_user_id: "dana",
    } as never);
    fake.push({
      event_kind: "agent_input",
      input_kind: "content",
      actor_id: "actr_dana",
      agent_input_id: "ain_shot",
      content_blocks: [
        { type: "text", text: "see this" },
        { type: "media_ref", artifact_id: "art_2" },
      ],
    });
    fake.onInput = () =>
      fake.output(fake.id("mcc"), [{ type: "text", text: "ok" }]);
    await run(agent, { text: "next" });
    expect(agent.messages.find((m) => m.id === "ain_shot")).toMatchObject({
      content: "see this\n[file]",
    });
  });

  it("shows a message sent elsewhere while idle under its sender's name, in order, and never resends it", async () => {
    const { fake, agent } = setup();
    replies(fake);
    await run(agent, { text: "one" });
    // Someone in Omnara's dashboard (an `omnara` actor, like subagents) writes
    // while the chat is idle.
    fake.actors.set("actr_dana", {
      provider: "omnara",
      display_name: "Dana",
      provider_user_id: "usr_dana",
    } as never);
    fake.push({
      event_kind: "agent_input",
      input_kind: "content",
      actor_id: "actr_dana",
      agent_input_id: "ain_dana",
      content_blocks: [{ type: "text", text: "from the dashboard" }],
    });
    fake.output("mcc_dana", [{ type: "text", text: "reply to Dana" }]);
    await run(agent, { text: "two" });
    expect(summary(agent.messages)).toEqual([
      ["user", "u-0", "one", undefined],
      ["assistant", MCC, "Hi there", undefined],
      ["user", "ain_dana", "from the dashboard", undefined],
      ["assistant", "mcc_dana", "reply to Dana", undefined],
      ["user", "u-2", "two", undefined],
      ["assistant", MCC, "Hi there", undefined],
    ]);
    expect(agent.messages.find((m) => m.id === "ain_dana")).toMatchObject({
      name: "Dana",
    });
    // Nothing missed this time: one snapshot, at the end.
    const third = await run(agent, { text: "three" });
    expect(third.filter((e) => e.type === "MESSAGES_SNAPSHOT")).toHaveLength(1);
    expect(fake.called("postInput").map((args) => args[2])).toEqual([
      "agui:u-0",
      "agui:u-2",
      "agui:u-6",
    ]);
  });

  it("restates only history from the oldest message the chat holds (server restart)", async () => {
    const { fake, agent } = setup();
    replies(fake);
    fake.push({
      event_kind: "agent_input",
      input_kind: "content",
      input_idempotency_key: "agui:old",
      content_blocks: [{ type: "text", text: "old" }],
    });
    fake.output("mcc_old", [{ type: "text", text: "old reply" }]);
    await run(agent, { text: "new" });
    expect(summary(agent.messages).map((m) => m[1])).toEqual(["u-0", MCC]);
  });

  it("restates no older history when none of the chat is in the log (server restart, message not posted)", async () => {
    const { fake, agent } = setup();
    fake.push({
      event_kind: "agent_input",
      input_kind: "content",
      input_idempotency_key: "agui:old",
      content_blocks: [{ type: "text", text: "old" }],
    });
    fake.output("mcc_old", [{ type: "text", text: "old reply" }]);
    fake.failNext.set("postInput", 503);
    await run(agent, { text: "new" }).catch(() => []);
    expect(summary(agent.messages).map((m) => m[1])).toEqual(["u-0"]);
  });

  it("keeps a thread on the agent it started with when the definition or profile changes", async () => {
    const { fake, agent } = setup();
    replies(fake);
    await run(agent, { text: "one" });
    // The host changes the definition, then switches to a profile.
    let previous = agent;
    for (const [text, launch] of [
      ["two", { definition: { source: "version: v1\ninstruction: changed" } }],
      ["three", { profile: "support-agent" }],
    ] as const) {
      const next = new OmnaraAgent(
        {
          orgId: "org",
          projectId: "proj",
          ...launch,
          user: { id: "u1", name: "Ada" },
          onError: vi.fn(),
        },
        fake,
      );
      next.threadId = "thread-1";
      for (const m of previous.messages) next.addMessage(m);
      await run(next, { text });
      previous = next;
    }
    const keys = fake.called("launch").map((args) => args[1]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(fake.called("postInput").map((args) => args[2])).toEqual([
      "agui:u-0",
      "agui:u-2",
      "agui:u-4",
    ]);
  });

  it("retries a message whose delivery failed, even with a later reply in the chat", async () => {
    const { fake, agent } = setup();
    replies(fake);
    await run(agent, { text: "one" });
    // Delivering the next message failed while the agent answered someone in
    // Omnara's dashboard, whose exchange reached the chat after it.
    agent.addMessage({ id: "u-lost", role: "user", content: "lost?" });
    fake.push({
      event_kind: "agent_input",
      input_kind: "content",
      agent_input_id: "ain_dana",
      content_blocks: [{ type: "text", text: "from the dashboard" }],
    });
    fake.output("mcc_dana", [{ type: "text", text: "reply to Dana" }]);
    agent.addMessage({
      id: "ain_dana",
      role: "user",
      content: "from the dashboard",
    });
    agent.addMessage({
      id: "mcc_dana",
      role: "assistant",
      content: "reply to Dana",
    });
    await run(agent, { text: "next" });
    expect(fake.called("postInput").map((args) => args[2])).toEqual([
      "agui:u-0",
      "agui:u-lost",
      "agui:u-5",
    ]);
  });

  it("doesn't send a message twice when the response to its delivery was lost", async () => {
    const { fake, agent } = setup();
    replies(fake);
    fake.loseNextInputResponse = true;
    const first = await run(agent, { text: "q" }).catch(() => []);
    expect(errored(first)?.code).toBe("run_failed");
    expect(finished(await run(agent))?.outcome).toEqual({ type: "success" });
    const inputs = fake.events.filter(
      (e) => e.event_kind === "agent_input" && e.input_kind === "content",
    );
    expect(inputs).toHaveLength(1);
    expect(summary(agent.messages)).toEqual([
      ["user", "u-0", "q", undefined],
      ["assistant", MCC, "Hi there", undefined],
    ]);
  });

  it("drops a preview the log never recorded, left in the chat by a missed snapshot", async () => {
    const { fake, agent } = setup();
    replies(fake);
    await run(agent, { text: "one" });
    // A dropped connection left a partial answer from a model call that failed.
    agent.addMessage({ id: "mcc_partial", role: "assistant", content: "Part" });
    await run(agent, { text: "two" });
    expect(agent.messages.some((m) => m.id === "mcc_partial")).toBe(false);
  });

  it("stops waiting for a cancelled message when the log ends with a config change", async () => {
    const { fake, agent } = setup();
    replies(fake);
    await run(agent, { text: "one" });
    // The page's tools changed after the last reply; the agent is idle.
    fake.push({
      event_kind: "agent_input",
      input_kind: "config_change",
      agent_config_id: "acfg_launch",
      content_blocks: [],
    });
    fake.cancelInputs = true;
    expect(finished(await run(agent, { text: "two" }))?.outcome).toEqual({
      type: "success",
    });
  });

  it("stops waiting for a new agent's first message cancelled before it started, also when it's sent again", async () => {
    const { fake, agent } = setup();
    fake.cancelInputs = true;
    expect(finished(await run(agent, { text: "q" }))?.outcome).toEqual({
      type: "success",
    });
    expect(finished(await run(agent))?.outcome).toEqual({ type: "success" });
    expect(fake.called("postInput").map((args) => args[2])).toEqual([
      "agui:u-0",
      "agui:u-0",
    ]);
  });

  it("stops waiting for a message cancelled before it started, also when it's sent again", async () => {
    const { fake, agent } = setup();
    replies(fake);
    await run(agent, { text: "one" });
    // Cancelled while queued (from Omnara's dashboard, say).
    fake.cancelInputs = true;
    expect(finished(await run(agent, { text: "two" }))?.outcome).toEqual({
      type: "success",
    });
    // Sent again as it was (Omnara returns the cancelled input), then with
    // changed page context (a conflict).
    expect(finished(await run(agent))?.outcome).toEqual({ type: "success" });
    const changed = await run(agent, {
      context: [{ description: "page", value: "changed" }],
    });
    expect(finished(changed)?.outcome).toEqual({ type: "success" });
    expect(fake.called("postInput").map((args) => args[2])).toEqual([
      "agui:u-0",
      "agui:u-2",
      "agui:u-2",
      "agui:u-2",
    ]);
  });

  it("launches an agent for any thread id (Omnara's agent-name rules)", async () => {
    const { fake, agent } = setup();
    replies(fake);
    agent.threadId = `chat about billing ❤️\tand ${"more ".repeat(20)}`;
    expect(finished(await run(agent, { text: "q" }))?.outcome).toEqual({
      type: "success",
    });
  });

  it("ends with a coded error when the model fails, with the detail sent to onError", async () => {
    const { fake, agent, onError } = setup();
    fake.onInput = () =>
      fake.output(
        "mcc_e",
        [{ type: "error", text: "provider exploded: secret" }],
        "error",
      );
    const events = await run(agent, { text: "q" }).catch(() => []);
    expect(errored(events)).toMatchObject({
      code: "model_error",
      message: "The model failed to respond.",
    });
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "provider exploded: secret" }),
      expect.objectContaining({ operation: "model_error" }),
    );
  });

  it("ends the chat when its agent was archived", async () => {
    const { fake, agent } = setup();
    fake.agent = { ...fake.agent, state: "archived" };
    const events = await run(agent, { text: "q" }).catch(() => []);
    expect(errored(events)?.code).toBe("thread_ended");
    expect(fake.called("postInput")).toEqual([]);
  });

  it("fails with run_failed when a message can't be posted, keeping the message in the chat", async () => {
    const { fake, agent } = setup();
    fake.failNext.set("postInput", 503);
    // The agent starts a reply while the failed run reads its final snapshot.
    const listEvents = fake.listEvents.bind(fake);
    fake.listEvents = async (agentId) => {
      if (fake.called("postInput").length) {
        fake.delta(fake.id("mcc"), 1, {
          kind: "block_start",
          block_index: 0,
          block: { kind: "text" },
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return listEvents(agentId);
    };
    const events = await run(agent, { text: "q" }).catch(() => []);
    expect(errored(events)?.code).toBe("run_failed");
    expect(events.some((e) => e.type === "TEXT_MESSAGE_START")).toBe(false);
    expect(summary(agent.messages)).toEqual([["user", "u-0", "q", undefined]]);
  });

  it("ends with message_too_large for a message over Omnara's limit, without sending it", async () => {
    const { fake, agent } = setup();
    const events = await run(agent, {
      text: "x".repeat(1024 * 1024 + 1),
    }).catch(() => []);
    expect(errored(events)?.code).toBe("message_too_large");
    expect(fake.called("postInput")).toEqual([]);
  });

  it("shows an approval the chat never saw instead of waiting behind it", async () => {
    const { fake, agent } = setup();
    // Opened from the dashboard while the chat was idle: Omnara queues the next message behind it.
    fake.interaction("int_old", "permission", "tcl_old");
    const post = fake.postInput.bind(fake);
    let queued = true;
    fake.postInput = async (...args: Parameters<FakeOmnara["postInput"]>) => {
      if (!queued) return post(...args);
      fake.calls.push({ method: "postInput", args });
    };
    const first = await run(agent, { text: "hello?" });
    expect(finished(first)?.outcome).toMatchObject({
      type: "interrupt",
      interrupts: [{ id: "int_old" }],
    });
    expect(agent.messages.map((m) => m.id)).toContain("u-0");

    // Answering it lets the queued message start; the next run follows it.
    queued = false;
    fake.onResolve = () => undefined;
    fake.onInput = () =>
      fake.output(fake.id("mcc"), [{ type: "text", text: "Yes, here." }]);
    const second = await run(agent, {
      resume: [
        {
          interruptId: "int_old",
          status: "resolved",
          payload: { approved: true },
        },
      ],
    });
    expect(finished(second)?.outcome).toEqual({ type: "success" });
    expect(summary(agent.messages).at(-1)).toEqual([
      "assistant",
      MCC,
      "Yes, here.",
      undefined,
    ]);
  });

  it("ends as cancelled when someone else cancels the turn", async () => {
    const { fake, agent } = setup();
    fake.onInput = () => {
      fake.delta("mcc_c", 1, {
        kind: "block_start",
        block_index: 0,
        block: { kind: "text" },
      });
      fake.push({
        event_kind: "agent_input",
        input_kind: "control",
        control_type: "cancel_current",
        content_blocks: [],
      });
    };
    const events = await run(agent, { text: "long task" });
    expect(finished(events)?.outcome).toEqual({ type: "cancelled" });

    // That cancel is history for the next run.
    fake.onInput = () =>
      fake.output(fake.id("mcc"), [{ type: "text", text: "ok" }]);
    const next = await run(agent, { text: "again" });
    expect(finished(next)?.outcome).toEqual({ type: "success" });
  });

  it("ends the chat when Omnara rejects the message because the agent was archived", async () => {
    const { fake, agent } = setup();
    fake.failNext.set("postInput", [409, "state_transition_conflict"]);
    const events = await run(agent, { text: "hello" }).catch(() => []);
    expect(errored(events)?.code).toBe("thread_ended");
  });

  it("ends right away when a request brings nothing new", async () => {
    const { fake, agent } = setup();
    replies(fake);
    await run(agent, { text: "q" });
    const events = await run(agent);
    expect(finished(events)?.outcome).toEqual({ type: "success" });
    expect(fake.called("postInput")).toHaveLength(1);
  });
});

describe("browser tools", () => {
  /** The agent calls the browser tool, then answers once it has the result. */
  function callsTool(fake: FakeOmnara) {
    fake.onInput = (text) => {
      if (text.startsWith("never mind"))
        return void fake.output(fake.id("mcc"), [{ type: "text", text: "ok" }]);
      const call = fake.id("tcl");
      fake.output(
        fake.id("mcc"),
        [
          {
            type: "tool_call",
            tool_call_id: call,
            tool_type: "custom",
            name: "change_background",
            input: { color: "blue" },
          },
        ],
        "tool_use",
      );
      fake.readyCall(call, "change_background");
      fake.update(call, "ready");
    };
    fake.onResult = () =>
      fake.output(fake.id("mcc"), [{ type: "text", text: "Done" }]);
  }

  it("adds, updates and removes the page's tools in the agent's config, keeping the profile's own", async () => {
    const { fake, agent } = setup();
    replies(fake);
    const noDescription = {
      name: "no_description",
      description: "",
      parameters: undefined,
    } as unknown as Tool;
    await run(agent, { text: "a", tools: [BACKGROUND, noDescription] });
    await run(agent, { text: "b", tools: [BACKGROUND, noDescription] });
    const sets = fake.called("setConfig");
    expect(sets).toHaveLength(1);
    const [, source, format, expected] = sets[0] as [
      string,
      string,
      string,
      string,
    ];
    expect(format).toBe("json");
    expect(expected).toBe("acfg_launch");
    const tools = JSON.parse(source).tools;
    expect(Object.keys(tools)).toEqual([
      "profile_tool",
      "change_background",
      "no_description",
    ]);
    expect(tools.no_description.description).toBe("no_description");

    // A tool keeping its name but changing its description, then its schema.
    const toolsSet = (n: number) =>
      JSON.parse((fake.called("setConfig")[n] as string[])[1]!).tools;
    const described = { ...BACKGROUND, description: "Paint the page." };
    await run(agent, { text: "c", tools: [described, noDescription] });
    expect(toolsSet(1).change_background.description).toBe("Paint the page.");
    const schema = {
      type: "object",
      properties: { color: { type: "string" } },
      required: ["color"],
    };
    await run(agent, {
      text: "d",
      tools: [{ ...described, parameters: schema }, noDescription],
    });
    expect(toolsSet(2).change_background.input_schema).toEqual(schema);

    await run(agent, { text: "e", tools: [] });
    expect(Object.keys(toolsSet(3))).toEqual(["profile_tool"]);
  });

  it("leaves a tool the agent's definition declares, built in or custom, as the definition has it", async () => {
    const { fake, agent } = setup({
      backendTools: [
        { name: "profile_tool", description: "Host-run.", handler: () => "ok" },
      ],
    });
    fake.configs.set(
      "acfg_launch",
      `version: v1
instruction: test
model: { provider_config: p, name: m }
tools:
  web_search: {}
  profile_tool: { type: custom, description: From the profile, input_schema: { type: object } }
`,
    );
    const pageSearch = {
      name: "web_search",
      description: "Search this page.",
      parameters: { type: "object", properties: {} },
    };
    replies(fake);
    await run(agent, { text: "a", tools: [pageSearch] });
    await run(agent, { text: "b", tools: [pageSearch] });
    expect(fake.called("setConfig")).toEqual([]);
  });

  it("fails with invalid_tools when Omnara rejects the page's tools, and run_failed when the key can't change them", async () => {
    const { fake, agent } = setup();
    fake.failNext.set("setConfig", 400);
    const events = await run(agent, { text: "a", tools: [BACKGROUND] }).catch(
      () => [],
    );
    expect(errored(events)?.code).toBe("invalid_tools");

    const other = setup();
    other.fake.failNext.set("setConfig", 403);
    const denied = await run(other.agent, {
      text: "a",
      tools: [BACKGROUND],
    }).catch(() => []);
    expect(errored(denied)?.code).toBe("run_failed");
  });

  it("hands a browser call to the page, then submits the page's result", async () => {
    const { fake, agent } = setup();
    callsTool(fake);
    const first = await run(agent, {
      text: "make it blue",
      tools: [BACKGROUND],
    });
    const call = pendingId(first);
    expect(finished(first)?.outcome).toEqual({
      type: "success",
      pendingToolCallIds: [call],
    });

    const second = await run(agent, {
      tools: [BACKGROUND],
      messages: [
        { id: "t-1", role: "tool", toolCallId: call, content: "changed" },
      ],
    });
    expect(fake.called("submitResult")[0]).toEqual([
      "agt_1",
      call,
      "succeeded",
      [{ type: "text", text: "changed" }],
    ]);
    expect(second.some((e) => e.type === "TOOL_CALL_RESULT")).toBe(false);
    expect(summary(agent.messages)).toEqual([
      ["user", "u-0", "make it blue", undefined],
      ["assistant", MCC, undefined, [call]],
      ["tool", "t-1", "changed", call],
      ["assistant", MCC, "Done", undefined],
    ]);
  });

  it("cancels a call the page abandoned before delivering the next message, and drops it from the chat", async () => {
    const { fake, agent } = setup();
    callsTool(fake);
    await run(agent, { text: "make it blue", tools: [BACKGROUND] });
    await run(agent, { text: "never mind", tools: [BACKGROUND] });
    const order = fake.calls
      .map((c) => c.method)
      .filter((m) => m === "cancel" || m === "postInput");
    expect(order).toEqual(["postInput", "cancel", "postInput"]);
    expect(summary(agent.messages).map((m) => m[1])).toEqual([
      "u-0",
      "u-2",
      MCC,
    ]);
  });

  it("submits a render-only result ahead of the next message", async () => {
    const { fake, agent } = setup();
    callsTool(fake);
    const call = pendingId(
      await run(agent, { text: "make it blue", tools: [BACKGROUND] }),
    );
    agent.addMessage({
      id: "t-1",
      role: "tool",
      toolCallId: call,
      content: "changed",
    });
    await run(agent, { text: "never mind", tools: [BACKGROUND] });
    const order = fake.calls
      .map((c) => c.method)
      .filter((m) => ["submitResult", "postInput", "cancel"].includes(m));
    expect(order).toEqual(["postInput", "submitResult", "postInput"]);
  });

  it("fails with run_failed when a result can't be delivered", async () => {
    const { fake, agent } = setup();
    callsTool(fake);
    const call = pendingId(
      await run(agent, { text: "make it blue", tools: [BACKGROUND] }),
    );
    fake.failNext.set("submitResult", 500);
    const events = await run(agent, {
      tools: [BACKGROUND],
      messages: [
        { id: "t-1", role: "tool", toolCallId: call, content: "changed" },
      ],
    }).catch(() => []);
    expect(errored(events)?.code).toBe("run_failed");
    expect(agent.messages.some((m) => m.id === "t-1")).toBe(true);
  });
});

describe("backend tools", () => {
  it("runs a host tool and returns its result to the agent", async () => {
    const handler = vi.fn(async () => ({ temperature: 21 }));
    const { fake, agent } = setup({
      backendTools: [{ name: "get_weather", description: "Weather.", handler }],
    });
    fake.onInput = () => {
      fake.output(
        "mcc_t",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_w",
            tool_type: "custom",
            name: "get_weather",
            input: { city: "Paris" },
          },
        ],
        "tool_use",
      );
      fake.readyCall("tcl_w", "get_weather");
      fake.update("tcl_w", "ready");
    };
    fake.onResult = () =>
      fake.output("mcc_done", [{ type: "text", text: "21 degrees" }]);
    const events = await run(agent, { text: "weather?" });
    expect(handler).toHaveBeenCalledWith({}, { toolCallId: "tcl_w" });
    expect(fake.called("submitResult")[0]).toEqual([
      "agt_1",
      "tcl_w",
      "succeeded",
      [{ type: "text", text: '{"temperature":21}' }],
    ]);
    expect(events.find((e) => e.type === "TOOL_CALL_RESULT")).toMatchObject({
      toolCallId: "tcl_w",
    });
    expect(finished(events)?.outcome).toEqual({ type: "success" });
  });

  it("returns a handler's error to the agent as a failed result", async () => {
    const { fake, agent } = setup({
      backendTools: [
        {
          name: "get_weather",
          description: "Weather.",
          handler: () => {
            throw new Error("no such city");
          },
        },
      ],
    });
    fake.onInput = () => {
      fake.output(
        "mcc_t",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_w",
            tool_type: "custom",
            name: "get_weather",
            input: {},
          },
        ],
        "tool_use",
      );
      fake.readyCall("tcl_w", "get_weather");
      fake.update("tcl_w", "ready");
    };
    fake.onResult = () =>
      fake.output("mcc_done", [{ type: "text", text: "sorry" }]);
    await run(agent, { text: "weather?" });
    expect(fake.called("submitResult")[0]).toEqual([
      "agt_1",
      "tcl_w",
      "failed",
      [{ type: "text", text: "no such city" }],
    ]);
  });

  it("sends a result over Omnara's limit as a failed result saying so", async () => {
    const { fake, agent, onError } = setup({
      backendTools: [
        {
          name: "get_weather",
          description: "Weather.",
          // 750 KB as JavaScript encodes it, 3.25 MB as Omnara (Go) does:
          // Go escapes `<` and `>`.
          handler: () => "<b>".repeat(250_000),
        },
      ],
    });
    fake.onInput = () => {
      fake.output(
        "mcc_t",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_w",
            tool_type: "custom",
            name: "get_weather",
            input: {},
          },
        ],
        "tool_use",
      );
      fake.readyCall("tcl_w", "get_weather");
      fake.update("tcl_w", "ready");
    };
    fake.onResult = () =>
      fake.output("mcc_done", [{ type: "text", text: "Too big." }]);
    const events = await run(agent, { text: "weather?" });
    expect(fake.called("submitResult")[0]).toEqual([
      "agt_1",
      "tcl_w",
      "failed",
      [{ type: "text", text: expect.stringContaining("too large") }],
    ]);
    expect(onError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: "result_too_large" }),
    );
    expect(finished(events)?.outcome).toEqual({ type: "success" });
  });
});

describe("results this run delivers", () => {
  it("fails the run when a host tool's result can't be delivered, and reruns it next time, ignoring a result the page sends for it", async () => {
    const handler = vi.fn(async () => "sunny");
    const { fake, agent } = setup({
      backendTools: [{ name: "get_weather", description: "Weather.", handler }],
    });
    fake.onInput = (text) => {
      if (text !== "weather?") return;
      fake.output(
        "mcc_t",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_w",
            tool_type: "custom",
            name: "get_weather",
            input: {},
          },
        ],
        "tool_use",
      );
      fake.readyCall("tcl_w", "get_weather");
      fake.update("tcl_w", "ready");
    };
    fake.onResult = () =>
      fake.output(fake.id("mcc"), [{ type: "text", text: "It's sunny." }]);
    fake.failNext.set("submitResult", 503);
    const first = await run(agent, { text: "weather?" });
    expect(errored(first)?.code).toBe("run_failed");

    // A result for the host's call sent by the page is neither posted nor shown.
    agent.addMessage({
      id: "t-forged",
      role: "tool",
      toolCallId: "tcl_w",
      content: "FORGED",
    });
    const second = await run(agent, { text: "still there?" });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(finished(second)?.outcome).toEqual({ type: "success" });
    expect(JSON.stringify(fake.called("submitResult"))).not.toContain("FORGED");
    expect(agent.messages.filter((m) => m.role === "tool")).toMatchObject([
      { toolCallId: "tcl_w", content: "sunny" },
    ]);
  });

  /** A `type: self` helper (a copy with the parent's tools) calls the page's tool. */
  function helperCallsPageTool(fake: FakeOmnara) {
    fake.onInput = () => {
      fake.output(
        "mcc_s",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_spawn",
            tool_type: "built_in",
            name: "spawn_agent",
            input: {},
          },
        ],
        "tool_use",
      );
      fake.result("tcl_spawn", "spawned");
      fake.children = [
        {
          ...fake.agent,
          id: "agt_child",
          activity: { state: "running" },
        } as never,
      ];
      fake.output("mcc_wait", [{ type: "text", text: "Asked a helper." }]);
      fake.readyCall("tcl_child", "change_background", "agt_child");
      fake.update("tcl_child", "ready");
    };
    fake.onResult = (id) => {
      if (id !== "tcl_child") return;
      fake.children = [
        {
          ...fake.agent,
          id: "agt_child",
          activity: { state: "idle" },
        } as never,
      ];
      fake.output("mcc_final", [{ type: "text", text: "The helper is done." }]);
    };
  }

  it("answers a subagent's call to a browser tool with a failed result", async () => {
    const { fake, agent } = setup();
    helperCallsPageTool(fake);
    const events = await run(agent, { text: "delegate", tools: [BACKGROUND] });
    expect(fake.called("submitResult")[0]).toEqual([
      "agt_child",
      "tcl_child",
      "failed",
      [
        {
          type: "text",
          text: "This tool runs in the user's browser; subagents can't use it.",
        },
      ],
    ]);
    expect(finished(events)?.outcome).toEqual({ type: "success" });
  });

  it("runs a subagent's call on the host when the page's tool is also a backend tool", async () => {
    const handler = vi.fn(async () => "changed");
    const { fake, agent } = setup({
      backendTools: [{ ...BACKGROUND, handler }],
    });
    helperCallsPageTool(fake);
    const events = await run(agent, { text: "delegate", tools: [BACKGROUND] });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fake.called("submitResult")).toEqual([
      [
        "agt_child",
        "tcl_child",
        "succeeded",
        [{ type: "text", text: "changed" }],
      ],
    ]);
    expect(finished(events)?.outcome).toEqual({ type: "success" });
  });
});

describe("approvals and questions", () => {
  function asksPermission(fake: FakeOmnara) {
    fake.onInput = () => {
      fake.output(
        "mcc_p",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_s",
            tool_type: "built_in",
            name: "web_search",
            input: {},
          },
        ],
        "tool_use",
      );
      fake.interaction("int_p", "permission", "tcl_s");
      fake.update("tcl_s", "awaiting_permission");
    };
    fake.onResolve = () => {
      fake.result("tcl_s", "results");
      fake.output("mcc_after", [{ type: "text", text: "found it" }]);
    };
  }

  it("ends with an interrupt carrying Omnara's form, and resolves it from the resume", async () => {
    const { fake, agent } = setup();
    asksPermission(fake);
    const first = await run(agent, { text: "search" });
    expect(finished(first)?.outcome).toMatchObject({
      type: "interrupt",
      interrupts: [
        {
          id: "int_p",
          reason: "omnara:permission",
          toolCallId: "tcl_s",
          metadata: { omnara: { kind: "permission" } },
        },
      ],
    });
    const second = await run(agent, {
      resume: [
        {
          interruptId: "int_p",
          status: "resolved",
          payload: { approved: true },
        },
      ],
    });
    expect(fake.called("resolveInteraction")[0]).toEqual([
      "agt_1",
      "int_p",
      [{ option_indices: [0] }],
      { provider_user_id: "u1", display_name: "Ada" },
    ]);
    expect(finished(second)?.outcome).toEqual({ type: "success" });
    expect(summary(agent.messages).at(-1)).toEqual([
      "assistant",
      "mcc_after",
      "found it",
      undefined,
    ]);
  });

  it("denies with a reason, and treats a dismissed approval as a denial", async () => {
    const { fake, agent } = setup();
    asksPermission(fake);
    await run(agent, { text: "search" });
    await run(agent, {
      resume: [
        {
          interruptId: "int_p",
          status: "resolved",
          payload: { approved: false, reason: "no" },
        },
      ],
    });
    expect(fake.called("resolveInteraction")[0]![2]).toEqual([
      { option_indices: [1], text: "no" },
    ]);

    await run(agent, { text: "search again" });
    await run(agent, {
      resume: [{ interruptId: "int_p", status: "cancelled" }],
    });
    expect(fake.called("resolveInteraction")[1]![2]).toEqual([
      {
        option_indices: [1],
        text: "The user dismissed this without answering.",
      },
    ]);
  });

  it("answers a question, and picks Other for a dismissed one", async () => {
    const { fake, agent } = setup();
    fake.onInput = () => {
      fake.output(
        "mcc_q",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_q",
            tool_type: "built_in",
            name: "ask_question",
            input: {},
          },
        ],
        "tool_use",
      );
      fake.interaction("int_q", "question", "tcl_q", ["Red", "Green", "Other"]);
      fake.update("tcl_q", "awaiting_permission");
    };
    fake.onResolve = () =>
      fake.output(fake.id("mcc"), [{ type: "text", text: "noted" }]);
    const first = await run(agent, { text: "ask me" });
    expect(finished(first)?.outcome).toMatchObject({
      interrupts: [{ reason: "omnara:question" }],
    });
    await run(agent, {
      resume: [
        {
          interruptId: "int_q",
          status: "resolved",
          payload: { answers: [{ optionIndices: [1] }] },
        },
      ],
    });
    expect(fake.called("resolveInteraction")[0]![2]).toEqual([
      { option_indices: [1] },
    ]);

    await run(agent, { text: "ask again" });
    await run(agent, {
      resume: [{ interruptId: "int_q", status: "cancelled" }],
    });
    expect(fake.called("resolveInteraction")[1]![2]).toEqual([
      {
        option_indices: [2],
        text: "The user dismissed this without answering.",
      },
    ]);
  });

  it("proceeds when the card was answered elsewhere", async () => {
    const { fake, agent, onError } = setup();
    asksPermission(fake);
    await run(agent, { text: "search" });
    // Answered from the dashboard while the chat was idle.
    fake.interactions = [];
    fake.result("tcl_s", "denied", "denied");
    fake.output("mcc_after", [{ type: "text", text: "was denied" }]);
    const events = await run(agent, {
      resume: [
        {
          interruptId: "int_p",
          status: "resolved",
          payload: { approved: true },
        },
      ],
    });
    expect(fake.called("resolveInteraction")).toEqual([]);
    expect(finished(events)?.outcome).toEqual({ type: "success" });
    expect(summary(agent.messages).at(-1)).toEqual([
      "assistant",
      "mcc_after",
      "was denied",
      undefined,
    ]);
    expect(onError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: "unknown_interrupt" }),
    );
  });
});

describe("approval and question edge cases", () => {
  function asksPermission(fake: FakeOmnara) {
    fake.onInput = () => {
      fake.output(
        "mcc_p",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_s",
            tool_type: "built_in",
            name: "web_search",
            input: {},
          },
        ],
        "tool_use",
      );
      fake.interaction("int_p", "permission", "tcl_s");
      fake.update("tcl_s", "awaiting_permission");
    };
    fake.onResolve = () => {
      fake.result("tcl_s", "results");
      fake.output("mcc_after", [{ type: "text", text: "found it" }]);
    };
  }
  const approve = {
    interruptId: "int_p",
    status: "resolved",
    payload: { approved: true },
  };

  it("shows the card again when an answer can't be delivered", async () => {
    const { fake, agent, onError } = setup();
    asksPermission(fake);
    await run(agent, { text: "search" });
    fake.failNext.set("resolveInteraction", 503);
    const events = await run(agent, { resume: [approve] });
    expect(finished(events)?.outcome).toMatchObject({
      type: "interrupt",
      interrupts: [{ id: "int_p" }],
    });
    expect(errored(events)).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: "resolve" }),
    );
  });

  it("carries on when an answer went through but its response was lost", async () => {
    const { fake, agent } = setup();
    asksPermission(fake);
    await run(agent, { text: "search" });
    const resolve = fake.resolveInteraction.bind(fake);
    fake.resolveInteraction = async (
      ...args: Parameters<FakeOmnara["resolveInteraction"]>
    ) => {
      await resolve(...args);
      throw new FakeApiError(504);
    };
    const events = await run(agent, { resume: [approve] });
    expect(finished(events)?.outcome).toEqual({ type: "success" });
    expect(summary(agent.messages).at(-1)).toEqual([
      "assistant",
      "mcc_after",
      "found it",
      undefined,
    ]);
  });

  it("answers every question of a form", async () => {
    const { fake, agent } = setup();
    fake.onInput = () => {
      fake.output(
        "mcc_q",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_q",
            tool_type: "built_in",
            name: "ask_question",
            input: {},
          },
        ],
        "tool_use",
      );
      const form = fake.interaction("int_q", "question", "tcl_q", [
        "Red",
        "Green",
        "Other",
      ]);
      form.request.questions.push({
        prompt: "Size?",
        multiple: true,
        options: [
          { label: "S" },
          { label: "M" },
          { label: "Other", allows_text: true },
        ],
      });
      fake.update("tcl_q", "awaiting_permission");
    };
    fake.onResolve = () =>
      fake.output(fake.id("mcc"), [{ type: "text", text: "noted" }]);
    await run(agent, { text: "ask me" });
    await run(agent, {
      resume: [
        {
          interruptId: "int_q",
          status: "resolved",
          payload: {
            answers: [
              { optionIndices: [1] },
              { optionIndices: [0, 2], text: "XL too" },
            ],
          },
        },
      ],
    });
    expect(fake.called("resolveInteraction")[0]![2]).toEqual([
      { option_indices: [1] },
      { option_indices: [0, 2], text: "XL too" },
    ]);
  });

  it("lists every open card and resolves each answer", async () => {
    const { fake, agent } = setup();
    fake.onInput = () => {
      fake.output(
        "mcc_two",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_a",
            tool_type: "built_in",
            name: "web_search",
            input: {},
          },
          {
            type: "tool_call",
            tool_call_id: "tcl_b",
            tool_type: "built_in",
            name: "web_fetch",
            input: {},
          },
        ],
        "tool_use",
      );
      fake.interaction("int_a", "permission", "tcl_a");
      fake.interaction("int_b", "permission", "tcl_b");
      fake.update("tcl_b", "awaiting_permission");
    };
    fake.onResolve = () => {
      if (fake.interactions.length) return;
      fake.result("tcl_a", "a");
      fake.result("tcl_b", "b");
      fake.output("mcc_done", [{ type: "text", text: "both done" }]);
    };
    const first = await run(agent, { text: "two things" });
    expect(finished(first)?.outcome).toMatchObject({
      type: "interrupt",
      interrupts: [{ id: "int_a" }, { id: "int_b" }],
    });
    const second = await run(agent, {
      resume: [
        {
          interruptId: "int_a",
          status: "resolved",
          payload: { approved: true },
        },
        {
          interruptId: "int_b",
          status: "resolved",
          payload: { approved: false, reason: "not that one" },
        },
      ],
    });
    expect(fake.called("resolveInteraction").map((a) => [a[1], a[2]])).toEqual([
      ["int_a", [{ option_indices: [0] }]],
      ["int_b", [{ option_indices: [1], text: "not that one" }]],
    ]);
    expect(finished(second)?.outcome).toEqual({ type: "success" });
  });
});

describe("subagents and stop", () => {
  it("waits for the report of a subagent it spawned, shown under the subagent's name", async () => {
    const { fake, agent } = setup();
    fake.actors.set("actr_child", {
      provider: "omnara",
      provider_user_id: "agt_child",
      display_name: "Helper",
    } as never);
    fake.onInput = () => {
      fake.output(
        "mcc_s",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_spawn",
            tool_type: "built_in",
            name: "spawn_agent",
            input: {},
          },
        ],
        "tool_use",
      );
      fake.push({
        event_kind: "tool_result",
        tool_call_id: "tcl_spawn",
        outcome: "succeeded",
        content_blocks: [
          { type: "structured_data", value: { agent_id: "agt_child" } },
        ],
      });
      fake.children = [
        {
          ...fake.agent,
          id: "agt_child",
          activity: { state: "running" },
        } as never,
      ];
      fake.output("mcc_wait", [{ type: "text", text: "Asked a helper." }]);
      setTimeout(() => {
        fake.children = [
          {
            ...fake.agent,
            id: "agt_child",
            activity: { state: "idle" },
          } as never,
        ];
        fake.push({
          event_kind: "agent_input",
          input_kind: "content",
          actor_id: "actr_child",
          agent_input_id: "ain_report",
          content_blocks: [{ type: "text", text: "391" }],
        });
        fake.output("mcc_final", [{ type: "text", text: "It's 391." }]);
      }, 50);
    };
    await run(agent, { text: "delegate" });
    expect(summary(agent.messages).slice(-2)).toEqual([
      ["assistant", "ain_report", "391", undefined],
      ["assistant", "mcc_final", "It's 391.", undefined],
    ]);
    expect(agent.messages.find((m) => m.id === "ain_report")).toMatchObject({
      name: "Helper",
    });
  });

  it("Stop cancels the running subagents and the agent, and ends as cancelled", async () => {
    const { fake, agent } = setup();
    fake.onInput = () => {
      fake.children = [
        { ...fake.agent, id: "agt_child", activity: { state: "running" } },
        { ...fake.agent, id: "agt_done", activity: { state: "idle" } },
      ] as never;
      fake.output(
        "mcc_s",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_spawn",
            tool_type: "built_in",
            name: "spawn_agent",
            input: {},
          },
        ],
        "tool_use",
      );
      fake.push({
        event_kind: "tool_result",
        tool_call_id: "tcl_spawn",
        outcome: "succeeded",
        content_blocks: [
          { type: "structured_data", value: { agent_id: "agt_child" } },
        ],
      });
      fake.delta("mcc_long", 1, {
        kind: "block_start",
        block_index: 0,
        block: { kind: "text" },
      });
      fake.delta("mcc_long", 2, {
        kind: "text_delta",
        block_index: 0,
        delta: "Working",
      });
      setTimeout(() => agent.abortRun(), 20);
    };
    const events = await run(agent, { text: "long task" });
    expect(fake.called("cancel").map((args) => args[0])).toEqual([
      "agt_child",
      "agt_1",
    ]);
    expect(finished(events)?.outcome).toEqual({ type: "cancelled" });
    // The partial preview was never recorded, so the snapshot drops it.
    expect(agent.messages.some((m) => m.id === "mcc_long")).toBe(false);
  });

  /** The parent spawns a helper and ends its turn; `then` scripts the helper. */
  function spawnsHelper(fake: FakeOmnara, then: () => void) {
    fake.actors.set("actr_child", {
      provider: "omnara",
      provider_user_id: "agt_child",
      display_name: "Helper",
    } as never);
    fake.onInput = () => {
      fake.output(
        "mcc_s",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_spawn",
            tool_type: "built_in",
            name: "spawn_agent",
            input: {},
          },
        ],
        "tool_use",
      );
      fake.result("tcl_spawn", "spawned");
      fake.children = [
        {
          ...fake.agent,
          id: "agt_child",
          activity: { state: "running" },
        } as never,
      ];
      fake.output("mcc_wait", [{ type: "text", text: "Asked a helper." }]);
      then();
    };
  }
  const helper = (fake: FakeOmnara, state: string) => {
    fake.children = [
      { ...fake.agent, id: "agt_child", activity: { state } } as never,
    ];
  };
  const report = (fake: FakeOmnara, id: string, text: string) =>
    fake.push({
      event_kind: "agent_input",
      input_kind: "content",
      actor_id: "actr_child",
      agent_input_id: id,
      content_blocks: [{ type: "text", text }],
    });

  it("ends when the agent stops its subagent (no report comes)", async () => {
    const { fake, agent } = setup();
    fake.onInput = () => {
      fake.output(
        "mcc_s",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_spawn",
            tool_type: "built_in",
            name: "spawn_agent",
            input: {},
          },
        ],
        "tool_use",
      );
      fake.result("tcl_spawn", "spawned");
      fake.children = [
        {
          ...fake.agent,
          id: "agt_child",
          activity: { state: "running" },
        } as never,
      ];
      fake.output(
        "mcc_stop",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_stop",
            tool_type: "built_in",
            name: "stop_agent",
            input: {},
          },
        ],
        "tool_use",
      );
      helper(fake, "idle");
      fake.result("tcl_stop", "stopped");
      fake.output("mcc_done", [{ type: "text", text: "Stopped the helper." }]);
    };
    const events = await run(agent, { text: "delegate, then stop it" });
    expect(finished(events)?.outcome).toEqual({ type: "success" });
    expect(summary(agent.messages).at(-1)).toEqual([
      "assistant",
      "mcc_done",
      "Stopped the helper.",
      undefined,
    ]);
  });

  it("waits for a report still in the agent's backlog", async () => {
    const { fake, agent } = setup();
    spawnsHelper(fake, () =>
      setTimeout(() => {
        // The helper finished: its report is stored but not delivered yet.
        helper(fake, "idle");
        fake.backlog = [{ id: "ain_report" }];
        fake.update("tcl_spawn", "completed"); // any frame makes the run look again
        fake.update("tcl_other", "ready");
        setTimeout(() => {
          fake.backlog = [];
          report(fake, "ain_report", "391");
          fake.output("mcc_final", [{ type: "text", text: "It's 391." }]);
        }, 200);
      }, 30),
    );
    const events = await run(agent, { text: "delegate" });
    expect(finished(events)?.outcome).toEqual({ type: "success" });
    expect(summary(agent.messages).at(-1)).toEqual([
      "assistant",
      "mcc_final",
      "It's 391.",
      undefined,
    ]);
    expect(fake.called("listBacklog").length).toBeGreaterThan(0);
  });

  it("after answering a subagent's question, waits for its result", async () => {
    const { fake, agent } = setup();
    spawnsHelper(fake, () => {
      helper(fake, "waiting_on_interaction");
      const question = fake.interaction("int_q", "question", "tcl_q", [
        "A",
        "B",
        "Other",
      ]);
      (question as { agent_id: string }).agent_id = "agt_child";
      fake.update("tcl_q", "awaiting_permission");
    });
    const first = await run(agent, { text: "delegate" });
    expect(finished(first)?.outcome).toMatchObject({ type: "interrupt" });

    fake.onResolve = () => {
      helper(fake, "running");
      setTimeout(() => {
        helper(fake, "idle");
        report(fake, "ain_result", "result: 42");
        fake.output("mcc_final", [
          { type: "text", text: "The helper says 42." },
        ]);
      }, 50);
    };
    await run(agent, {
      resume: [
        {
          interruptId: "int_q",
          status: "resolved",
          payload: { answers: [{ optionIndices: [0] }] },
        },
      ],
    });
    expect(summary(agent.messages).slice(-2)).toEqual([
      ["assistant", "ain_result", "result: 42", undefined],
      ["assistant", "mcc_final", "The helper says 42.", undefined],
    ]);
  });

  it("a closed connection does not cancel the agent", async () => {
    const { fake, agent, onError } = setup();
    fake.onInput = () =>
      fake.delta("mcc_x", 1, {
        kind: "block_start",
        block_index: 0,
        block: { kind: "text" },
      });
    agent.addMessage({ id: "u-0", role: "user", content: "q" });
    const subscription = agent
      .run({
        threadId: "thread-1",
        runId: "r1",
        messages: agent.messages,
        tools: [],
        context: [],
      })
      .subscribe();
    await new Promise((r) => setTimeout(r, 50));
    subscription.unsubscribe();
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.called("cancel")).toEqual([]);
    // Leaving isn't a failure.
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("races and Stop", () => {
  const approval = (fake: FakeOmnara, id: string, call: string) => {
    fake.output(
      fake.id("mcc"),
      [
        {
          type: "tool_call",
          tool_call_id: call,
          tool_type: "built_in",
          name: "web_search",
          input: {},
        },
      ],
      "tool_use",
    );
    fake.interaction(id, "permission", call);
    fake.update(call, "awaiting_permission");
  };

  it("a queued message that starts while the answer is being submitted doesn't hold the run", async () => {
    const { fake, agent } = setup();
    // Opened from the dashboard: the chat's message queues behind it.
    fake.interaction("int_old", "permission", "tcl_old");
    let key = "";
    fake.postInput = async (...args: Parameters<FakeOmnara["postInput"]>) => {
      fake.calls.push({ method: "postInput", args });
      key = args[2]; // queued, or replayed as already queued
    };
    await run(agent, { text: "hello?" });

    // Answering lets Omnara start the queued message before the adapter re-posts it.
    const resolve = fake.resolveInteraction.bind(fake);
    fake.resolveInteraction = async (
      ...args: Parameters<FakeOmnara["resolveInteraction"]>
    ) => {
      await resolve(...args);
      fake.push({
        event_kind: "agent_input",
        input_kind: "content",
        input_idempotency_key: key,
        content_blocks: [{ type: "text", text: "hello?" }],
        is_opening_event: true,
      });
      fake.output(fake.id("mcc"), [{ type: "text", text: "Yes, here." }]);
      await new Promise((r) => setTimeout(r, 20));
    };
    const events = await run(agent, {
      resume: [
        {
          interruptId: "int_old",
          status: "resolved",
          payload: { approved: true },
        },
      ],
    });
    expect(finished(events)?.outcome).toEqual({ type: "success" });
    expect(summary(agent.messages).at(-1)).toEqual([
      "assistant",
      MCC,
      "Yes, here.",
      undefined,
    ]);
  });

  it("shows the card again when the open cards can't be looked up", async () => {
    const { fake, agent } = setup();
    fake.onInput = () => approval(fake, "int_p", "tcl_s");
    await run(agent, { text: "search" });
    fake.failNext.set("openInteractions", 503);
    const events = await run(agent, {
      resume: [
        {
          interruptId: "int_p",
          status: "resolved",
          payload: { approved: true },
        },
      ],
    });
    expect(errored(events)).toBeUndefined();
    expect(finished(events)?.outcome).toMatchObject({
      type: "interrupt",
      interrupts: [{ id: "int_p" }],
    });
    expect(fake.called("resolveInteraction")).toEqual([]);
  });

  it("doesn't end when a subagent's report starts during the completion checks", async () => {
    const { fake, agent } = setup();
    fake.actors.set("actr_child", {
      provider: "omnara",
      provider_user_id: "agt_child",
      display_name: "Helper",
    } as never);
    fake.onInput = () => {
      fake.output(
        "mcc_s",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_spawn",
            tool_type: "built_in",
            name: "spawn_agent",
            input: {},
          },
        ],
        "tool_use",
      );
      fake.result("tcl_spawn", "spawned");
      fake.output("mcc_wait", [{ type: "text", text: "Asked a helper." }]);
    };
    // The helper finishes while the run checks it: its report starts before the
    // children list returns, and the parent answers it a little later.
    let reported = false;
    const list = fake.listChildren.bind(fake);
    fake.listChildren = async (id: string) => {
      if (!reported) {
        reported = true;
        fake.push({
          event_kind: "agent_input",
          input_kind: "content",
          actor_id: "actr_child",
          agent_input_id: "ain_report",
          content_blocks: [{ type: "text", text: "391" }],
          is_opening_event: true,
        });
        await new Promise((r) => setTimeout(r, 20));
        setTimeout(
          () => fake.output("mcc_final", [{ type: "text", text: "It's 391." }]),
          100,
        );
      }
      return list(id);
    };
    fake.children = [
      { ...fake.agent, id: "agt_child", activity: { state: "idle" } } as never,
    ];
    const events = await run(agent, { text: "delegate" });
    expect(finished(events)?.outcome).toEqual({ type: "success" });
    expect(summary(agent.messages).at(-1)).toEqual([
      "assistant",
      "mcc_final",
      "It's 391.",
      undefined,
    ]);
  });

  it("leaves a profile subagent's own custom tool to its worker", async () => {
    const { fake, agent } = setup();
    fake.actors.set("actr_child", {
      provider: "omnara",
      provider_user_id: "agt_child",
      display_name: "Lookup",
    } as never);
    fake.onInput = () => {
      fake.output(
        "mcc_s",
        [
          {
            type: "tool_call",
            tool_call_id: "tcl_spawn",
            tool_type: "built_in",
            name: "spawn_agent",
            input: {},
          },
        ],
        "tool_use",
      );
      fake.result("tcl_spawn", "spawned");
      fake.children = [
        {
          ...fake.agent,
          id: "agt_child",
          activity: { state: "running" },
        } as never,
      ];
      fake.output("mcc_wait", [{ type: "text", text: "Asked a helper." }]);
      fake.readyCall("tcl_lookup", "customer_lookup", "agt_child");
      fake.update("tcl_lookup", "ready");
      // The profile's own worker answers it.
      setTimeout(() => {
        fake.readyCalls = [];
        fake.children = [
          {
            ...fake.agent,
            id: "agt_child",
            activity: { state: "idle" },
          } as never,
        ];
        fake.push({
          event_kind: "agent_input",
          input_kind: "content",
          actor_id: "actr_child",
          agent_input_id: "ain_report",
          content_blocks: [{ type: "text", text: "found" }],
          is_opening_event: true,
        });
        fake.output("mcc_final", [
          { type: "text", text: "Found the customer." },
        ]);
      }, 100);
    };
    const events = await run(agent, { text: "look up a customer" });
    expect(fake.called("submitResult")).toEqual([]);
    expect(finished(events)?.outcome).toEqual({ type: "success" });
  });

  it("Stop during setup still cancels the agent's work, nested subagents included", async () => {
    const { fake, agent } = setup();
    // Helpers from an earlier request: one running, and an idle one whose own
    // helper is running.
    fake.children = [
      {
        ...fake.agent,
        id: "agt_child",
        activity: { state: "running" },
      } as never,
      {
        ...fake.agent,
        id: "agt_idle",
        activity: { state: "idle" },
      } as never,
      {
        ...fake.agent,
        id: "agt_grand",
        parent_agent_id: "agt_idle",
        activity: { state: "running" },
      } as never,
    ];
    agent.addMessage({ id: "u-0", role: "user", content: "x" });
    const events: BaseEvent[] = [];
    await agent.runAgent({ tools: [], context: [] } as never, {
      onEvent: ({ event }) => {
        events.push(event);
        if (event.type === "RUN_STARTED") agent.abortRun();
      },
    });
    expect(finished(events)?.outcome).toEqual({ type: "cancelled" });
    expect(fake.called("cancel").map((args) => args[0])).toEqual([
      "agt_child",
      "agt_grand",
      "agt_1",
    ]);
    expect(fake.called("postInput")).toEqual([]);
  });
});
