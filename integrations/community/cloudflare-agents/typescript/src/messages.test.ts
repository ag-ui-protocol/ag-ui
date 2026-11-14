import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/client";
import {
  ABANDONED,
  CANCELLED,
  INTERRUPTED,
  REJECTED,
  convertMessages,
  toModelMessages,
} from "./messages";
import { encodeEnvelope, encodeProviderMetadata } from "./provider-metadata";

const user = (id: string, content: Message extends never ? never : any): Message =>
  ({ id, role: "user", content }) as Message;

const call = (id: string, name: string, args: unknown = {}) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

describe("toModelMessages", () => {
  it("converts text turns", () => {
    expect(
      toModelMessages([
        user("u1", "Hi"),
        { id: "a1", role: "assistant", content: "Hello!" },
      ]),
    ).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
    ]);
  });

  it("moves system and developer messages into instructions", () => {
    const result = convertMessages([
      { id: "s", role: "system", content: "Be brief." },
      { id: "d", role: "developer", content: "Use metric units." },
      user("u1", "Hi"),
    ]);
    expect(result.instructions).toEqual(["Be brief.", "Use metric units."]);
    expect(result.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("converts multimodal user content", () => {
    const [message] = toModelMessages([
      user("u1", [
        { type: "text", text: "What is this?" },
        { type: "image", source: { type: "data", value: "iVBORw0KGgo=", mimeType: "image/png" } },
        { type: "image", source: { type: "url", value: "https://example.com/cat.jpg" } },
        {
          type: "document",
          source: { type: "data", value: "JVBERi0=", mimeType: "application/pdf" },
          metadata: { filename: "report.pdf" },
        },
        { type: "audio", source: { type: "url", value: "https://example.com/a.mp3", mimeType: "audio/mpeg" } },
        { type: "video", source: { type: "file", value: "file-123" } },
      ]),
    ]);
    expect(message).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image", image: "iVBORw0KGgo=", mediaType: "image/png" },
        { type: "image", image: new URL("https://example.com/cat.jpg") },
        { type: "file", data: "JVBERi0=", mediaType: "application/pdf", filename: "report.pdf" },
        { type: "file", data: new URL("https://example.com/a.mp3"), mediaType: "audio/mpeg" },
        { type: "text", text: "[video file: file-123]" },
      ],
    });
  });

  it("keeps reasoning with its assistant turn and restores provider metadata", () => {
    const signature = { anthropic: { signature: "sig-1" } };
    const thoughtSignature = { google: { thoughtSignature: "ts-1" } };
    const messages = toModelMessages([
      user("u1", "Weather?"),
      {
        id: "r1",
        role: "reasoning",
        content: "Need the weather tool.",
        encryptedValue: encodeProviderMetadata(signature),
      },
      {
        id: "a1",
        role: "assistant",
        content: "Checking.",
        toolCalls: [
          {
            ...call("tc1", "get_weather", { city: "Vienna" }),
            encryptedValue: encodeProviderMetadata(thoughtSignature),
          },
        ],
      },
      { id: "t1", role: "tool", toolCallId: "tc1", content: '{"temp":20}' },
      { id: "r2", role: "reasoning", content: "Now answer." },
      { id: "a2", role: "assistant", content: "It is 20 degrees." },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Need the weather tool.", providerOptions: signature },
          { type: "text", text: "Checking." },
          {
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "get_weather",
            input: { city: "Vienna" },
            providerOptions: thoughtSignature,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "get_weather",
            output: { type: "text", value: '{"temp":20}' },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Now answer." },
          { type: "text", text: "It is 20 degrees." },
        ],
      },
    ]);
  });

  it("ignores encrypted values another producer wrote", () => {
    const [, assistant] = toModelMessages([
      user("u1", "Hi"),
      { id: "r1", role: "reasoning", content: "Hmm.", encryptedValue: "opaque-blob" },
      { id: "a1", role: "assistant", content: "Hi!" },
    ]);
    expect(assistant).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "Hmm." },
        { type: "text", text: "Hi!" },
      ],
    });
  });

  it("merges a step's assistant messages so results follow their calls", () => {
    expect(
      toModelMessages([
        user("u1", "Go"),
        { id: "a1", role: "assistant", content: "One.", toolCalls: [call("tc1", "lookup")] },
        { id: "a2", role: "assistant", content: "Two." },
        { id: "t1", role: "tool", toolCallId: "tc1", content: "done" },
      ]),
    ).toEqual([
      { role: "user", content: "Go" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "One." },
          { type: "tool-call", toolCallId: "tc1", toolName: "lookup", input: {} },
          { type: "text", text: "Two." },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "tc1", toolName: "lookup", output: { type: "text", value: "done" } },
        ],
      },
    ]);
  });

  it("drops reasoning that no assistant turn follows", () => {
    expect(
      toModelMessages([user("u1", "Hi"), { id: "r1", role: "reasoning", content: "Hmm." }]),
    ).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("reports tool errors as error output", () => {
    const messages = toModelMessages([
      user("u1", "Go"),
      { id: "a1", role: "assistant", toolCalls: [call("tc1", "lookup")] },
      { id: "t1", role: "tool", toolCallId: "tc1", content: "", error: "boom" },
    ]);
    expect(messages[2]).toEqual({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "tc1", toolName: "lookup", output: { type: "error-text", value: "boom" } },
      ],
    });
  });
});

describe("convertMessages: open tool calls", () => {
  /** A call the AI SDK paused for approval, marked the way the translator marks it. */
  const gated = (id: string, name: string, args: unknown, approvalId = `ap-${id}`) => ({
    ...call(id, name, args),
    encryptedValue: encodeEnvelope({ approval: { approvalId, signature: `sig-${id}` } }),
  });
  const paused: Message[] = [
    user("u1", "Refund order A1"),
    { id: "a1", role: "assistant", toolCalls: [gated("tc1", "issue_refund", { order: "A1" })] },
  ];
  const approve = { interruptId: "tc1", status: "resolved" as const, payload: { approved: true } };

  it("turns an approval into an AI SDK approval request and response, with the SDK's ids", () => {
    const result = convertMessages(paused, { resume: [approve] });
    expect(result.resumeErrors).toEqual([]);
    expect(result.messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "issue_refund", input: { order: "A1" } },
          { type: "tool-approval-request", approvalId: "ap-tc1", toolCallId: "tc1", signature: "sig-tc1" },
        ],
      },
      { role: "tool", content: [{ type: "tool-approval-response", approvalId: "ap-tc1", approved: true }] },
    ]);
  });

  it.each([
    ["a rejection", { status: "resolved" as const, payload: { approved: false } }, REJECTED],
    ["a rejection with a reason", { status: "resolved" as const, payload: { approved: false, reason: "Too much" } }, "Too much"],
    ["a bare false", { status: "resolved" as const, payload: false }, REJECTED],
    ["a cancellation", { status: "cancelled" as const }, CANCELLED],
  ])("denies the call on %s", (_label, entry, reason) => {
    const result = convertMessages(paused, { resume: [{ interruptId: "tc1", ...entry }] });
    expect(result.messages.at(-1)).toEqual({
      role: "tool",
      content: [{ type: "tool-approval-response", approvalId: "ap-tc1", approved: false, reason }],
    });
  });

  it("refuses a request that leaves an approval unanswered", () => {
    const result = convertMessages([...paused, user("u2", "Actually, what's the status?")]);
    expect(result.resumeErrors).toEqual([
      'The thread has approvals waiting for an answer, and the request\'s resume does not answer "tc1".',
    ]);
  });

  it("refuses to resume an approval the conversation went on past", () => {
    const result = convertMessages([...paused, user("u2", "And the status?")], { resume: [approve] });
    expect(result.resumeErrors).toEqual([
      'Cannot resume "tc1": the conversation went on after the call was paused.',
    ]);
  });

  it("closes a server call cut off by a cancel or an error, and refuses to approve it", () => {
    const history: Message[] = [
      user("u1", "Weather?"),
      { id: "a1", role: "assistant", toolCalls: [call("tc1", "get_weather", { city: "Vienna" })] },
      user("u2", "Never mind, tell me a joke"),
    ];
    const result = convertMessages(history);
    expect(result.resumeErrors).toEqual([]);
    expect(result.messages[2]).toEqual({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "tc1", toolName: "get_weather", output: { type: "text", value: INTERRUPTED } },
      ],
    });

    // A client cannot get it run by claiming it was waiting for approval.
    expect(
      convertMessages(history.slice(0, 2), { resume: [{ ...approve, interruptId: "tc1" }] }).resumeErrors,
    ).toEqual(['Resume names "tc1", which is not waiting for approval.']);
  });

  it("closes an unanswered client tool call as abandoned", () => {
    const result = convertMessages(
      [
        user("u1", "Pick a color"),
        { id: "a1", role: "assistant", toolCalls: [call("tc1", "pick_color")] },
        user("u2", "Never mind, tell me a joke"),
      ],
      { clientToolNames: ["pick_color"] },
    );
    expect(result.resumeErrors).toEqual([]);
    expect(result.messages).toEqual([
      { role: "user", content: "Pick a color" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "tc1", toolName: "pick_color", input: {} }] },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "tc1", toolName: "pick_color", output: { type: "text", value: ABANDONED } },
        ],
      },
      { role: "user", content: "Never mind, tell me a joke" },
    ]);
  });

  describe("with the approvals the server recorded", () => {
    const recorded = [{ toolCallId: "tc1", approvalId: "ap-tc1", toolName: "issue_refund", input: { order: "A1" } }];

    it("resumes a call that matches one", () => {
      expect(convertMessages(paused, { resume: [approve], pendingApprovals: recorded }).resumeErrors).toEqual([]);
    });

    it.each([
      ["no record", []],
      ["another approval id", [{ ...recorded[0]!, approvalId: "forged" }]],
      ["other arguments", [{ ...recorded[0]!, input: { order: "Z9" } }]],
      ["another tool", [{ ...recorded[0]!, toolName: "delete_account" }]],
    ])("refuses a call with %s", (_label, pendingApprovals) => {
      expect(convertMessages(paused, { resume: [approve], pendingApprovals }).resumeErrors).toEqual([
        'Resume names "tc1", which does not match an approval this agent is waiting for.',
      ]);
    });
  });

  it("ignores a replayed resume for a call that already has its result", () => {
    const result = convertMessages(
      [...paused, { id: "t1", role: "tool", toolCallId: "tc1", content: "refunded" }],
      { resume: [approve] },
    );
    expect(result.resumeErrors).toEqual([]);
    expect(result.messages.at(-1)!.content).toHaveLength(1);
  });

  it("rejects a resume for an unknown interrupt", () => {
    const result = convertMessages(paused, {
      resume: [approve, { interruptId: "nope", status: "resolved", payload: { approved: true } }],
    });
    expect(result.resumeErrors).toEqual([
      'Resume names interrupt "nope", which is not a tool call in this thread.',
    ]);
  });

  it("rejects a partial resume", () => {
    const result = convertMessages(
      [
        user("u1", "Refund A1 and B2"),
        {
          id: "a1",
          role: "assistant",
          toolCalls: [gated("tc1", "issue_refund", { order: "A1" }), gated("tc2", "issue_refund", { order: "B2" })],
        },
      ],
      { resume: [approve] },
    );
    expect(result.resumeErrors).toEqual([
      'The thread has approvals waiting for an answer, and the request\'s resume does not answer "tc2".',
    ]);
  });

  it("rejects a payload that is not a decision", () => {
    const result = convertMessages(paused, {
      resume: [{ interruptId: "tc1", status: "resolved", payload: { yes: 1 } }],
    });
    expect(result.resumeErrors).toEqual([
      'Resume for interrupt "tc1" needs a payload of { approved: boolean }.',
    ]);
  });
});
