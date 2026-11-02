import { describe, expect, it } from "vitest";
import {
  buildAguiToolMessage,
  convertAguiToolToClaudeSdk,
  mergeStateUpdate,
  frontendResultBlocks,
  stripMcpPrefix,
} from "./utils";

describe("tool result fidelity", () => {
  it("preserves every rich result block in order", () => {
    const blocks = [
      { type: "text", text: "caption" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AQID" },
      },
      { type: "text", text: "second" },
    ];
    const result = buildAguiToolMessage("call-original", blocks);
    expect(result.content).toMatchObject([
      { type: "text", text: "caption" },
      {
        type: "image",
        source: { type: "data", value: "AQID", mimeType: "image/png" },
      },
      { type: "text", text: "second" },
    ]);
    expect(
      (
        result.content as Array<{ metadata: { claude: { block: unknown } } }>
      ).map((p) => p.metadata.claude.block),
    ).toEqual(blocks);
    expect((result as { toolCallId: string }).toolCallId).toBe("call-original");
  });
  it("preserves text block metadata", () => {
    const blocks = [
      { type: "text", text: "value", annotations: { audience: ["user"] } },
    ];
    expect(buildAguiToolMessage("call", blocks).content).toMatchObject([
      { metadata: { claude: { block: blocks[0] } } },
    ]);
  });
  it("does not quote bare text or change its bytes", () => {
    expect(buildAguiToolMessage("call", "plain").content).toBe("plain");
    expect(
      buildAguiToolMessage("call", [{ type: "text", text: ' { "x": 1 } ' }])
        .content,
    ).toBe(' { "x": 1 } ');
  });
});

it("returns the exact resolved frontend answer to the SDK tool", async () => {
  const answer = ' { "approved": false, "reason": "No" } ';
  const proxy = convertAguiToolToClaudeSdk(
    {
      name: "confirm",
      description: "",
      parameters: { type: "object", properties: { title: { type: "string" } } },
    },
    (name, args) => {
      expect(name).toBe("confirm");
      expect(args).toEqual({ title: "original" });
      return answer;
    },
  );
  expect(await proxy.handler({ title: "original" }, {})).toEqual({
    content: [{ type: "text", text: answer }],
  });
});
it("cannot complete a frontend tool with a placeholder", async () => {
  const proxy = convertAguiToolToClaudeSdk({
    name: "confirm",
    description: "",
    parameters: {},
  });
  await expect(proxy.handler({}, {})).rejects.toThrow(
    "matched deferred tool call",
  );
});
it("preserves an error result's rich blocks", () => {
  const blocks = [
    { type: "text", text: "failed" },
    {
      type: "resource",
      resource: {
        uri: "ui://chart",
        mimeType: "text/html",
        text: "<div>chart</div>",
      },
    },
  ];
  expect(buildAguiToolMessage("id", blocks, true).content).toMatchObject(
    blocks.map((block) => ({ metadata: { claude: { block, isError: true } } })),
  );
});

it("shallow-merges state without losing untouched keys or deep-merging replacements", () => {
  const before = { keep: 1, nested: { old: true }, values: [1] };
  expect(
    mergeStateUpdate(before, {
      state_updates: { nested: { next: true }, values: [] },
    }),
  ).toEqual({ keep: 1, nested: { next: true }, values: [] });
  expect(before.nested).toEqual({ old: true });
  expect(() => mergeStateUpdate(before, { state_updates: [] })).toThrow(
    "must be an object",
  );
});

it("preserves structured frontend image bytes and external MCP names", () => {
  expect(
    frontendResultBlocks([
      {
        type: "image",
        source: { type: "data", value: "AQID", mimeType: "image/png" },
      },
    ]),
  ).toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);
  expect(stripMcpPrefix("mcp__external__confirm")).toBe(
    "mcp__external__confirm",
  );
  expect(stripMcpPrefix("mcp__ag_ui__confirm")).toBe("confirm");
});

it.each([
  {
    content: "",
    error: "denied",
    expected: [{ type: "text", text: "denied" }],
  },
  {
    content: "detail",
    error: "",
    expected: [{ type: "text", text: "detail" }],
  },
  {
    content: "detail",
    error: "denied",
    expected: [
      { type: "text", text: "detail" },
      { type: "text", text: "denied" },
    ],
  },
])(
  "preserves frontend failure status and reason: $error",
  async ({ content, error, expected }) => {
    const proxy = convertAguiToolToClaudeSdk(
      { name: "confirm", description: "", parameters: {} },
      () => ({ content, error }),
    );
    expect(await proxy.handler({}, {})).toEqual({
      content: expected,
      isError: true,
    });
  },
);

it("accepts successful rich frontend result envelopes", async () => {
  const proxy = convertAguiToolToClaudeSdk(
    { name: "image", description: "", parameters: {} },
    () => ({
      content: [
        {
          type: "image",
          source: { type: "data", value: "AQID", mimeType: "image/png" },
        },
      ],
    }),
  );
  expect(await proxy.handler({}, {})).toEqual({
    content: [{ type: "image", data: "AQID", mimeType: "image/png" }],
  });
});

it("retains empty result failure status after a JSON round trip", () => {
  const success = JSON.parse(
    JSON.stringify(buildAguiToolMessage("empty", [], false)),
  );
  const failure = JSON.parse(
    JSON.stringify(buildAguiToolMessage("empty", [], true)),
  );
  expect(success.content).toEqual([]);
  expect(success.error).toBeUndefined();
  expect(failure.content).toEqual([]);
  expect(failure.error).toBeTruthy();
});
