import { describe, expect, it, vi } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/client";
import { asSchema } from "ai";
import { toClientTools } from "./tools";
import { buildInstructions, formatContext } from "./instructions";
import {
  decodeProviderMetadata,
  encodeProviderMetadata,
  mergeProviderMetadata,
} from "./provider-metadata";
import { EventChannel, mergeWithChannel } from "./event-channel";
import { parseFrame, threadUrl } from "./protocol";

describe("toClientTools", () => {
  it("turns client tools into AI SDK tools the client runs", async () => {
    const tools = toClientTools([
      {
        name: "change_background",
        description: "Change the background",
        parameters: { type: "object", properties: { color: { type: "string" } }, required: ["color"] },
      },
      { name: "ping", description: "No parameters" },
    ]);
    expect(Object.keys(tools)).toEqual(["change_background", "ping"]);
    expect(tools.change_background!.execute).toBeUndefined();
    expect(tools.change_background!.description).toBe("Change the background");
    expect(await asSchema(tools.change_background!.inputSchema).jsonSchema).toEqual({
      type: "object",
      properties: { color: { type: "string" } },
      required: ["color"],
    });
    // Providers reject a tool without an object schema.
    expect(await asSchema(tools.ping!.inputSchema).jsonSchema).toEqual({ type: "object", properties: {} });
  });

  it("accepts no tools", () => {
    expect(toClientTools(undefined)).toEqual({});
  });
});

describe("buildInstructions", () => {
  it("puts each part in its own section and leaves out empty ones", () => {
    expect(
      buildInstructions({
        base: "You are helpful.",
        systemMessages: ["Answer in German.", "  "],
        context: [{ description: "Page", value: "/home" }],
        state: { count: 1 },
      }),
    ).toBe(
      [
        "You are helpful.",
        "Answer in German.",
        "Context from the application:\n- Page: /home",
        'Shared state (the application shows it to the user and can change it):\n{\n  "count": 1\n}',
      ].join("\n\n"),
    );
    expect(buildInstructions({ base: "Hi.", context: [], state: {} })).toBe("Hi.");
  });

  it("formats context entries one per line", () => {
    expect(
      formatContext([
        { description: "User", value: "Ada" },
        { description: "", value: "" },
        { description: "Plan", value: "pro" },
      ]),
    ).toBe("- User: Ada\n- Plan: pro");
  });
});

describe("provider metadata", () => {
  it("merges per provider and round-trips through an encrypted value", () => {
    const merged = mergeProviderMetadata(
      mergeProviderMetadata(undefined, { anthropic: { signature: "a" } }),
      { anthropic: { redacted: false }, openai: { itemId: "rs_1" } },
    );
    expect(merged).toEqual({ anthropic: { signature: "a", redacted: false }, openai: { itemId: "rs_1" } });
    expect(decodeProviderMetadata(encodeProviderMetadata(merged))).toEqual(merged);
  });

  it("ignores values it did not write", () => {
    expect(encodeProviderMetadata(undefined)).toBeUndefined();
    expect(encodeProviderMetadata({})).toBeUndefined();
    expect(decodeProviderMetadata("gAAAAABencrypted")).toBeUndefined();
    expect(decodeProviderMetadata('{"other":1}')).toBeUndefined();
    expect(decodeProviderMetadata("{not json")).toBeUndefined();
  });
});

describe("mergeWithChannel", () => {
  const custom = (name: string): BaseEvent => ({ type: EventType.CUSTOM, name, value: null }) as BaseEvent;

  it("delivers channel events while the source is waiting", async () => {
    const channel = new EventChannel();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    async function* source() {
      yield "first";
      await gate;
      yield "second";
    }
    const seen: string[] = [];
    const merged = (async () => {
      for await (const item of mergeWithChannel(source(), channel)) {
        if ("part" in item) {
          seen.push(item.part);
          if (item.part === "first") channel.push(custom("progress"));
        } else {
          seen.push(...item.events.map((e) => (e as unknown as { name: string }).name));
          release();
        }
      }
    })();
    await merged;
    expect(seen).toEqual(["first", "progress", "second"]);
  });

  it("cancels the source when the consumer stops early", async () => {
    let cancelled = false;
    async function* source() {
      try {
        yield 1;
        yield 2;
      } finally {
        cancelled = true;
      }
    }
    for await (const item of mergeWithChannel(source(), new EventChannel())) {
      expect(item).toEqual({ part: 1 });
      break;
    }
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("passes a source error through", async () => {
    async function* failing() {
      yield 1;
      throw new Error("boom");
    }
    const items: unknown[] = [];
    await expect(
      (async () => {
        for await (const item of mergeWithChannel(failing(), new EventChannel())) items.push(item);
      })(),
    ).rejects.toThrow("boom");
    expect(items).toEqual([{ part: 1 }]);
  });
});

describe("protocol", () => {
  it("builds a thread's URL", () => {
    expect(threadUrl("https://w.example/agents/chat/", "a b")).toBe("https://w.example/agents/chat/a%20b");
    expect(threadUrl("wss://w.example/agents/chat?x=1", "t")).toBe("wss://w.example/agents/chat/t?x=1");
  });

  it("parses only AG-UI frames", () => {
    expect(parseFrame('{"type":"ag-ui:abort","runId":"r"}')).toEqual({ type: "ag-ui:abort", runId: "r" });
    expect(parseFrame(new TextEncoder().encode('{"type":"ag-ui:run"}').buffer)).toEqual({ type: "ag-ui:run" });
    expect(parseFrame('{"type":"cf_agent_state"}')).toBeUndefined();
    expect(parseFrame('{"note":"mentions \\"ag-ui:run\\""}')).toBeUndefined();
    expect(parseFrame("not json ag-ui:")).toBeUndefined();
    expect(parseFrame(42)).toBeUndefined();
  });
});
