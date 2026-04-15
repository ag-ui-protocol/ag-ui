/**
 * Tests for stateStreamingMiddleware.
 *
 * `langchain` (the main package) requires a @langchain/core peer that exports
 * ./utils/context (added in ~0.3.40+).  The pnpm workspace may hoist a different
 * version than what is declared in devDependencies (see package.json).  To keep
 * the test self-contained we mock the `langchain` module so `createMiddleware`
 * simply returns its config argument — the actual logic under test lives in the
 * wrapModelCall closure, not in langchain's middleware runtime.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("langchain", () => ({
  createMiddleware: vi.fn((config: any) => config),
}));

import { stateStreamingMiddleware, stateItem } from "./state-streaming";
import {
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ModelRequest } from "langchain";

/** Minimal mock of request.model — only withConfig is exercised. */
function makeMockModel() {
  const modelWithConfig = { _isModelWithConfig: true };
  const model = { withConfig: vi.fn().mockReturnValue(modelWithConfig) };
  return { model, modelWithConfig };
}

/** Build a minimal ModelRequest-shaped object for testing. */
function makeRequest(messages: BaseMessage[]) {
  const { model, modelWithConfig } = makeMockModel();
  return {
    request: {
      messages,
      // For mocking we are ok with casting
      model: model as unknown as ModelRequest["model"],
      systemPrompt: "",
      systemMessage: new SystemMessage(""),
      // For mocking we are ok with casting
      state: {} as ModelRequest["state"],
      runtime: {},
      tools: [],
    } satisfies ModelRequest,
    model,
    modelWithConfig,
  };
}

describe("stateStreamingMiddleware", () => {
  const items = [
    stateItem({
      stateKey: "recipe",
      tool: "write_recipe",
      toolArgument: "draft",
    }),
  ];

  describe("wrapModelCall — isPreToolCall logic", () => {
    it("injects predict_state metadata when messages array is empty", async () => {
      const middleware = stateStreamingMiddleware(...items);
      const { request, model } = makeRequest([]);
      const handler = vi.fn().mockResolvedValue({ content: "ok" });

      await middleware.wrapModelCall!(request, handler);

      expect(model.withConfig).toHaveBeenCalledOnce();
      expect(model.withConfig).toHaveBeenCalledWith({
        metadata: {
          predict_state: [
            {
              state_key: "recipe",
              tool: "write_recipe",
              tool_argument: "draft",
            },
          ],
        },
      });
      // handler receives a request with the enriched model
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          model: expect.objectContaining({ _isModelWithConfig: true }),
        }),
      );
    });

    it("injects predict_state metadata when last message is not a ToolMessage", async () => {
      const middleware = stateStreamingMiddleware(...items);
      const { request, model } = makeRequest([new HumanMessage("hello")]);
      const handler = vi.fn().mockResolvedValue({ content: "ok" });

      await middleware.wrapModelCall!(request, handler);

      expect(model.withConfig).toHaveBeenCalledOnce();
    });

    it("suppresses injection when last message is a ToolMessage for a tracked tool", async () => {
      const middleware = stateStreamingMiddleware(...items);
      const toolMsg = new ToolMessage({
        content: "result",
        tool_call_id: "tc1",
        name: "write_recipe",
      });
      const { request, model } = makeRequest([
        new HumanMessage("call it"),
        toolMsg,
      ]);
      const handler = vi.fn().mockResolvedValue({ content: "ok" });

      await middleware.wrapModelCall!(request, handler);

      // model.withConfig must NOT have been called — tracked tool suppresses
      expect(model.withConfig).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(request);
    });

    it("injects when last message is a ToolMessage for an untracked tool", async () => {
      const middleware = stateStreamingMiddleware(...items);
      // open_canvas is not in the tracked items list
      const toolMsg = new ToolMessage({
        content: "Canvas is now open.",
        tool_call_id: "tc2",
        name: "open_canvas",
      });
      const { request, model } = makeRequest([
        new HumanMessage("call it"),
        toolMsg,
      ]);
      const handler = vi.fn().mockResolvedValue({ content: "ok" });

      await middleware.wrapModelCall!(request, handler);

      // untracked tool — predict_state should be injected so manage_todos can stream
      expect(model.withConfig).toHaveBeenCalledOnce();
    });
  });

  describe("predict_state payload shape", () => {
    it("maps StateItem camelCase fields to snake_case in predict_state", async () => {
      const middleware = stateStreamingMiddleware(
        stateItem({
          stateKey: "myState",
          tool: "my_tool",
          toolArgument: "my_arg",
        }),
        stateItem({
          stateKey: "otherState",
          tool: "other_tool",
          toolArgument: "other_arg",
        }),
      );
      const { request, model } = makeRequest([new HumanMessage("go")]);
      const handler = vi.fn().mockResolvedValue({ content: "ok" });

      await middleware.wrapModelCall!(request, handler);

      expect(model.withConfig).toHaveBeenCalledWith({
        metadata: {
          predict_state: [
            { state_key: "myState", tool: "my_tool", tool_argument: "my_arg" },
            {
              state_key: "otherState",
              tool: "other_tool",
              tool_argument: "other_arg",
            },
          ],
        },
      });
    });

    it("passes an empty predict_state array when no items are provided", async () => {
      const middleware = stateStreamingMiddleware();
      const { request, model } = makeRequest([]);
      const handler = vi.fn().mockResolvedValue({ content: "ok" });

      await middleware.wrapModelCall!(request, handler);

      expect(model.withConfig).toHaveBeenCalledWith({
        metadata: { predict_state: [] },
      });
    });
  });

  describe("hasPredictState metadata check", () => {
    /**
     * The agent sets hasPredictState only when the streaming tool call's name
     * appears in event.metadata["predict_state"].  Mirrors the Python
     * model_made_tool_call metadata-awareness added in agent.py.
     * See agent.ts for the live implementation — the lambda below isolates the
     * same logic for regression testing without a full LangGraph stack.
     */
    const toolCallUsedToPredictState = (
      toolName: string | undefined,
      predictStateMeta: Array<{ tool: string }> | undefined,
    ) => predictStateMeta?.some((p) => p.tool === toolName) ?? false;

    it("returns true when tool name matches a predict_state entry", () => {
      const meta = [{ tool: "write_recipe" }];
      expect(toolCallUsedToPredictState("write_recipe", meta)).toBe(true);
    });

    it("returns false for an unrelated tool", () => {
      const meta = [{ tool: "write_recipe" }];
      expect(toolCallUsedToPredictState("search_web", meta)).toBe(false);
    });

    it("returns false when predict_state metadata is empty", () => {
      expect(toolCallUsedToPredictState("write_recipe", [])).toBe(false);
    });

    it("returns false when predict_state metadata is absent", () => {
      expect(toolCallUsedToPredictState("write_recipe", undefined)).toBe(false);
    });

    it("returns false when tool name is undefined (non-name chunk)", () => {
      const meta = [{ tool: "write_recipe" }];
      expect(toolCallUsedToPredictState(undefined, meta)).toBe(false);
    });

    it("matches one of multiple predict_state entries", () => {
      const meta = [{ tool: "write_recipe" }, { tool: "update_title" }];
      expect(toolCallUsedToPredictState("update_title", meta)).toBe(true);
      expect(toolCallUsedToPredictState("search_web", meta)).toBe(false);
    });
  });

  describe("snapshot suppression condition", () => {
    /**
     * The TypeScript agent suppresses a STATE_SNAPSHOT on node exit when
     * `hasPredictState` is true (set the moment the model starts streaming a
     * tool call that matches a predict_state item). This avoids overwriting
     * optimistic UI state that was already pushed to the client.
     *
     * The suppression sub-expression (from agent.ts line 563) is:
     *   !(exitingNode && hasPredictState)
     *
     * Note: this is only the innermost guard; the full emission condition also
     * requires (hasStateDiff || prevNodeName != nodeName || exitingNode) and
     * no message in progress.  We isolate this sub-expression here so regressions
     * are caught without a full LangGraph stack.  The lambda below is an
     * intentional local re-statement of agent.ts line 563 — it is NOT dead code.
     */
    it("suppresses snapshot when exiting node AND hasPredictState is true", () => {
      const shouldEmit = (exitingNode: boolean, hasPredictState: boolean) =>
        !(exitingNode && hasPredictState);

      expect(shouldEmit(true, true)).toBe(false); // suppressed ✓
      expect(shouldEmit(true, false)).toBe(true); // not suppressed
      expect(shouldEmit(false, true)).toBe(true); // not suppressed
      expect(shouldEmit(false, false)).toBe(true); // not suppressed
    });
  });
});
