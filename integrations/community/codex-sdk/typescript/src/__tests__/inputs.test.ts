import { describe, expect, it } from "vitest";
import type { RunAgentInput, Message } from "@ag-ui/core";
import { fingerprint, projectInput } from "../inputs";

const limits = { maxInputBytes: 1024 * 1024, maxMessages: 2000 };
const user = {
  id: "u1",
  role: "user",
  content: "Hi <literal>\nthere",
} satisfies Message;
function input(messages: Message[] = [user]): RunAgentInput {
  return {
    threadId: "t",
    runId: "r",
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}

describe("input projection", () => {
  it("preserves first-turn text and identifies transcript context", () => {
    expect(projectInput(input(), undefined, limits).prompt).toBe(
      'AG-UI text transcript context:\n<user>\nHi <literal>\nthere\n</user>\n\nAG-UI read-only request context and state:\n{"context":[],"state":{}}',
    );
  });

  it("sends only fresh input and updated context on continuation", () => {
    const assistant = {
      id: "a1",
      role: "assistant",
      content: "Hello",
    } satisfies Message;
    const next = { id: "u2", role: "user", content: "Next" } satisfies Message;
    const request = {
      ...input([user, assistant, next]),
      context: [{ description: "Current page", value: "second" }],
      state: { selected: "new" },
    };
    const projected = projectInput(
      request,
      {
        status: "ready",
        nativeId: "native",
        fingerprints: [fingerprint(user), fingerprint(assistant)],
      },
      limits,
    );
    expect(projected.prompt).toContain("<user>\nNext\n</user>");
    expect(projected.prompt).not.toContain("Hello");
    expect(projected.prompt).toContain('"selected":"new"');
    expect(projected.prompt).toContain('"value":"second"');
  });

  it("ignores retained reasoning in canonical history", () => {
    const assistant = {
      id: "a",
      role: "assistant",
      content: "Answer",
    } satisfies Message;
    const reasoning = {
      id: "reason",
      role: "reasoning",
      content: "Summary",
    } satisfies Message;
    const next = { id: "u2", role: "user", content: "Again" } satisfies Message;
    const record = {
      status: "ready",
      nativeId: "n",
      fingerprints: [fingerprint(user), fingerprint(assistant)],
    } as const;
    expect(
      projectInput(
        input([user, reasoning, assistant, next]),
        { ...record, fingerprints: [...record.fingerprints] },
        limits,
      ),
    ).toEqual(
      projectInput(
        input([user, assistant, next]),
        { ...record, fingerprints: [...record.fingerprints] },
        limits,
      ),
    );
  });

  it("rejects edits, replay, imported assistant history and failed sessions", () => {
    const record = {
      status: "ready" as const,
      nativeId: "n",
      fingerprints: [fingerprint(user)],
    };
    expect(() =>
      projectInput(input([{ ...user, content: "edited" }]), record, limits),
    ).toThrow("history changed");
    expect(() => projectInput(input(), record, limits)).toThrow("new user");
    expect(() =>
      projectInput(
        input([{ id: "a", role: "assistant", content: "past" }, user]),
        undefined,
        limits,
      ),
    ).toThrow("No trusted session");
    expect(() =>
      projectInput(input(), { status: "failed", fingerprints: [] }, limits),
    ).toThrow("interrupted");
  });

  it("rejects tools, tool results, non-text content and overrides", () => {
    expect(() =>
      projectInput(
        {
          ...input(),
          tools: [{ name: "tool", description: "Test tool", parameters: {} }],
        },
        undefined,
        limits,
      ),
    ).toThrow("Frontend tools");
    expect(() =>
      projectInput(
        input([
          { id: "tool", role: "tool", toolCallId: "c", content: "result" },
          user,
        ]),
        undefined,
        limits,
      ),
    ).toThrow("Only text");
    expect(() =>
      projectInput(
        input([
          {
            ...user,
            content: [
              {
                type: "image",
                source: { type: "url", value: "https://example.com/a.png" },
              },
            ],
          },
        ]),
        undefined,
        limits,
      ),
    ).toThrow("plain text");
    expect(() =>
      projectInput(
        { ...input(), forwardedProps: { model: "bad" } },
        undefined,
        limits,
      ),
    ).toThrow("Per-request overrides");
    expect(() =>
      projectInput({ ...input(), forwardedProps: "bad" }, undefined, limits),
    ).toThrow("Per-request overrides");
  });

  it("limits input bytes, history and duplicate IDs before SDK work", () => {
    expect(() =>
      projectInput(input(), undefined, { ...limits, maxInputBytes: 8 }),
    ).toThrow("byte limit");
    expect(() =>
      projectInput(input(), undefined, { ...limits, maxMessages: 1 }),
    ).toThrow("history is full");
    expect(() => projectInput(input([user, user]), undefined, limits)).toThrow(
      "unique",
    );
  });
});
