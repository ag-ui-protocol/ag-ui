import { describe, it, expect, vi, afterEach } from "vitest";
import type { Message } from "@ag-ui/client";
import { convertAGUIMessageToLangChain } from "../messages";

describe("convertAGUIMessageToLangChain — tool messages", () => {
  it("maps a tool result with no error to status 'success'", () => {
    const msg: Message = { id: "t1", role: "tool", content: "42", toolCallId: "tc1" };
    const result = convertAGUIMessageToLangChain(msg) as any;
    expect(result.tool_call_id).toBe("tc1");
    // No error carries no failure signal, so status defaults to "success".
    expect(result.status).toBe("success");
  });

  it("maps a tool error onto LangChain's status flag", () => {
    // A client-reported tool failure must reach the model as an error, not a
    // silent success — AG-UI's ToolMessage.error becomes status: "error".
    const msg: Message = {
      id: "t1",
      role: "tool",
      content: "Tool failed: invalid id",
      toolCallId: "tc1",
      error: "invalid id",
    };
    const result = convertAGUIMessageToLangChain(msg) as any;
    expect(result.status).toBe("error");
  });
});

describe("convertAGUIMessageToLangChain — tool message content parts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flattens text parts to a string instead of passing AG-UI parts to LangChain", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const msg: Message = {
      id: "t1",
      role: "tool",
      toolCallId: "tc1",
      content: [
        { type: "text", text: "first, " },
        { type: "text", text: "second" },
      ],
    };
    const result = convertAGUIMessageToLangChain(msg);
    expect(result.content).toBe("first, second");
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops media parts from a tool result with a warning naming the call", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const msg: Message = {
      id: "t1",
      role: "tool",
      toolCallId: "tc1",
      content: [
        { type: "text", text: "chart attached" },
        { type: "image", source: { type: "url", value: "https://example.com/c.png" } },
      ],
    };
    const result = convertAGUIMessageToLangChain(msg);
    expect(result.content).toBe("chart attached");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("tc1");
  });
});

describe("convertAGUIMessageToLangChain — user message content parts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps text-only parts as a plain string", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const msg: Message = {
      id: "u1",
      role: "user",
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
    };
    const result = convertAGUIMessageToLangChain(msg);
    expect(result.content).toBe("hello world");
    expect(warn).not.toHaveBeenCalled();
  });

  it("maps URL and inline image parts to LangChain image_url blocks, in order", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const msg: Message = {
      id: "u1",
      role: "user",
      content: [
        { type: "text", text: "compare these" },
        { type: "image", source: { type: "url", value: "https://example.com/a.png" } },
        { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
      ],
    };
    const result = convertAGUIMessageToLangChain(msg);
    expect(result.content).toEqual([
      { type: "text", text: "compare these" },
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops parts with no LangChain mapping with a warning instead of silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const msg: Message = {
      id: "u1",
      role: "user",
      content: [
        { type: "text", text: "listen" },
        { type: "audio", source: { type: "url", value: "https://example.com/a.mp3" } },
        { type: "image", source: { type: "file", value: "file-123" } },
      ],
    };
    const result = convertAGUIMessageToLangChain(msg);
    expect(result.content).toBe("listen");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("u1");
    expect(warn.mock.calls[0][0]).toContain("audio");
    expect(warn.mock.calls[0][0]).toContain("image (file source)");
  });

  it("honours SUPPRESS_TRANSFORMATION_WARNINGS", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("SUPPRESS_TRANSFORMATION_WARNINGS", "1");
    const msg: Message = {
      id: "u1",
      role: "user",
      content: [{ type: "audio", source: { type: "url", value: "https://example.com/a.mp3" } }],
    };
    convertAGUIMessageToLangChain(msg);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("convertAGUIMessageToLangChain — assistant tool calls", () => {
  // Guards the next turn after a no-argument tool call: when no TOOL_CALL_ARGS
  // was streamed (this bridge skips empty arg deltas), the client stores the
  // call with arguments "", and JSON.parse("") aborted the whole run.
  it("converts a tool call whose arguments are empty to empty args", () => {
    const msg: Message = {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "tc1", type: "function", function: { name: "get_time", arguments: "" } },
      ],
    };
    const result = convertAGUIMessageToLangChain(msg) as any;
    expect(result.tool_calls).toMatchObject([{ id: "tc1", name: "get_time", args: {} }]);
  });
});
