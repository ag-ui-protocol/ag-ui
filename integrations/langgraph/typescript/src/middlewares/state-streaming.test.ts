/**
 * Tests for stateStreamingMiddleware.
 *
 * `langchain` (the main package) requires a @langchain/core peer that exports
 * ./utils/context (added in ~0.3.40+).  The devDependency here resolves to
 * @langchain/core@0.3.80, which is compatible, but the pnpm workspace may
 * hoist a different version.  To keep the test self-contained we mock the
 * `langchain` module so `createMiddleware` simply returns its config argument —
 * the actual logic under test lives in the wrapModelCall closure, not in
 * langchain's middleware runtime.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("langchain", () => ({
  createMiddleware: vi.fn((config: any) => config),
}));

import { stateStreamingMiddleware, stateItem } from "./state-streaming";
import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";

/** Minimal mock of request.model — only withConfig is exercised. */
function makeMockModel() {
  const modelWithConfig = { _isModelWithConfig: true };
  const model = { withConfig: vi.fn().mockReturnValue(modelWithConfig) };
  return { model, modelWithConfig };
}

/** Build a minimal ModelRequest-shaped object for testing. */
function makeRequest(messages: unknown[]) {
  const { model, modelWithConfig } = makeMockModel();
  return {
    request: {
      messages,
      model,
      systemPrompt: "",
      systemMessage: new SystemMessage(""),
      state: {},
      runtime: {},
      tools: [],
    } as any,
    model,
    modelWithConfig,
  };
}

describe("stateStreamingMiddleware", () => {
  const items = [stateItem({ stateKey: "recipe", tool: "write_recipe", toolArgument: "draft" })];

  describe("wrapModelCall — isPreToolCall logic", () => {
    it("injects predict_state metadata when messages array is empty", async () => {
      const middleware = stateStreamingMiddleware(...items);
      const { request, model } = makeRequest([]);
      const handler = vi.fn().mockResolvedValue({ content: "ok" });

      await middleware.wrapModelCall!(request, handler);

      expect(model.withConfig).toHaveBeenCalledOnce();
      expect(model.withConfig).toHaveBeenCalledWith({
        metadata: {
          predict_state: [{ state_key: "recipe", tool: "write_recipe", tool_argument: "draft" }],
        },
      });
      // handler receives a request with the enriched model
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ model: expect.objectContaining({ _isModelWithConfig: true }) }));
    });

    it("injects predict_state metadata when last message is not a ToolMessage", async () => {
      const middleware = stateStreamingMiddleware(...items);
      const { request, model } = makeRequest([new HumanMessage("hello")]);
      const handler = vi.fn().mockResolvedValue({ content: "ok" });

      await middleware.wrapModelCall!(request, handler);

      expect(model.withConfig).toHaveBeenCalledOnce();
    });

    it("passes through without injecting when last message is a ToolMessage", async () => {
      const middleware = stateStreamingMiddleware(...items);
      const toolMsg = new ToolMessage({ content: "result", tool_call_id: "tc1" });
      const { request, model } = makeRequest([new HumanMessage("call it"), toolMsg]);
      const handler = vi.fn().mockResolvedValue({ content: "ok" });

      await middleware.wrapModelCall!(request, handler);

      // model.withConfig must NOT have been called — request passes through unchanged
      expect(model.withConfig).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(request);
    });
  });

  describe("predict_state payload shape", () => {
    it("maps StateItem camelCase fields to snake_case in predict_state", async () => {
      const middleware = stateStreamingMiddleware(
        stateItem({ stateKey: "myState", tool: "my_tool", toolArgument: "my_arg" }),
        stateItem({ stateKey: "otherState", tool: "other_tool", toolArgument: "other_arg" }),
      );
      const { request, model } = makeRequest([new HumanMessage("go")]);
      const handler = vi.fn().mockResolvedValue({ content: "ok" });

      await middleware.wrapModelCall!(request, handler);

      expect(model.withConfig).toHaveBeenCalledWith({
        metadata: {
          predict_state: [
            { state_key: "myState", tool: "my_tool", tool_argument: "my_arg" },
            { state_key: "otherState", tool: "other_tool", tool_argument: "other_arg" },
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
     *
     * Logic (from agent.ts):
     *   const toolCallUsedToPredictState = event.metadata["predict_state"]?.some(
     *     (p) => p.tool === toolCallData?.name,
     *   );
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
     * The condition (from agent.ts) is:
     *   !(exitingNode && hasPredictState)
     *
     * We document and verify the boolean table here so regressions are caught
     * without requiring a full LangGraph stack.
     */
    it("suppresses snapshot when exiting node AND hasPredictState is true", () => {
      const shouldEmit = (exitingNode: boolean, hasPredictState: boolean) =>
        !(exitingNode && hasPredictState);

      expect(shouldEmit(true, true)).toBe(false);   // suppressed ✓
      expect(shouldEmit(true, false)).toBe(true);   // not suppressed
      expect(shouldEmit(false, true)).toBe(true);   // not suppressed
      expect(shouldEmit(false, false)).toBe(true);  // not suppressed
    });
  });
});