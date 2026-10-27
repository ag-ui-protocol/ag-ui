import { expect, it, vi } from "vitest";
import { type HookInput, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { RunAgentInput } from "@ag-ui/core";
import { NativeHistory, type ChildCheckpoint } from "./native-history";
import { NativeChildRecovery } from "./native-recovery";
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
it.each([false, true])(
  "denies a parent Agent during bridge recovery (background=%s)",
  async (background) => {
    const checkpoint: ChildCheckpoint = {
      parentPath: "unused",
      childPath: "unused",
      childId: "child",
      parent: { id: "parent", name: "Agent", input: {} },
      pending: [],
      calls: [],
    };
    const inspect = vi
      .spyOn(NativeHistory.prototype, "children")
      .mockResolvedValue([checkpoint]);
    const root = vi.spyOn(NativeHistory.prototype, "root").mockResolvedValue({
      ...checkpoint,
      childId: "",
      parent: { id: "", name: "", input: {} },
    });
    let decision: unknown;
    let bridgePrompt: unknown;
    queryMock.mockImplementation(
      ({
        options,
        prompt,
      }: {
        options: Options;
        prompt: AsyncIterable<{ message: { content: unknown } }>;
      }) => {
        const stream = (async function* () {
          bridgePrompt = (await prompt[Symbol.asyncIterator]().next()).value
            .message.content;
          const hook = options!.hooks!.PreToolUse!.at(-1)!.hooks[0];
          const input: HookInput = {
            hook_event_name: "PreToolUse",
            session_id: "session",
            transcript_path: "unused",
            cwd: "/tmp",
            tool_name: "Agent",
            tool_use_id: "nested",
            tool_input: { run_in_background: background },
          };
          decision = await hook(input, "nested", {
            signal: new AbortController().signal,
          });
          throw new Error("fixture stopped");
        })();
        // The recovery runner only consumes the iterator and close in this fixture.
        return Object.assign(stream, { close: vi.fn() });
      },
    );
    const recovery = new NativeChildRecovery({
      directory: "unused",
      tools: ["Read"],
      execute: vi.fn(),
      acquire: async () => async () => {},
    });
    const input: RunAgentInput = {
      threadId: "thread",
      runId: "run",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };
    try {
      await expect(async () => {
        for await (const _ of recovery.run(
          input,
          { resume: "11111111-1111-4111-8111-111111111111" },
          "continue",
        )) {
        }
      }).rejects.toThrow("fixture stopped");
      // Persisted history consumers recognize this exact protocol text.
      // Changing it requires a compatible reader migration, not a copy edit.
      expect(bridgePrompt).toBe(
        "Resume child child with SendMessage, message exactly: Continue the original task using the recorded tool results. Do not repeat completed tools.",
      );
      expect(decision).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    } finally {
      inspect.mockRestore();
      root.mockRestore();
    }
  },
);
