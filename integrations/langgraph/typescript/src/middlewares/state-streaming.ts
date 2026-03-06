/**
 * Custom middleware helpers for CopilotKit agents.
 */

import { createMiddleware } from "langchain";
import { BaseMessage, ToolMessage } from "@langchain/core/messages";

export interface StateItem {
  stateKey: string;
  tool: string;
  toolArgument: string;
}

/** Identity helper — exists purely for IDE type inference on the object literal. */
export const stateItem = (item: StateItem): StateItem => item;

/**
 * Middleware that injects `predict_state` metadata into model invocations so
 * that every `on_chat_model_stream` event carries it.
 *
 * Approach: wrap `request.model` with `model.withConfig({ metadata: {
 * predict_state } })` before passing it to the base handler. When the base
 * handler subsequently calls `bindTools()` on this RunnableBinding,
 * `_simpleBindTools` detects the RunnableBinding wrapper and creates a new
 * RunnableBinding that **preserves our config**. `RunnableBinding.invoke()`
 * then uses `mergeConfigs()` (which deep-merges metadata) to combine our
 * bound config with the LangGraph execution config, so `predict_state`
 * survives into every streaming event.
 */
export const stateStreamingMiddleware = (...items: StateItem[]) => {
  const predictState = items.map((i) => ({
    state_key: i.stateKey,
    tool: i.tool,
    tool_argument: i.toolArgument,
  }));

  /**
   * Return true if this model call may generate the initial tool call.
   * When the last message is a ToolMessage the tool has already run and
   * the model is being called for a follow-up response. Injecting
   * predict_state in that case would re-trigger streaming if the model
   * decides to call the same tool again, producing a duplicate stream.
   */
  const isPreToolCall = (request: { messages?: BaseMessage[] }): boolean => {
    const msgs = request?.messages ?? [];
    if (msgs.length === 0) return true;
    return !(msgs[msgs.length - 1] instanceof ToolMessage);
  };

  return createMiddleware({
    name: "StateStreamingMiddleware",
    wrapModelCall: async (request, handler) => {
      if (!isPreToolCall(request)) {
        return handler(request);
      }
      const modelWithState = request.model.withConfig({
        metadata: { predict_state: predictState },
      });
      return handler({ ...request, model: modelWithState });
    },
  });
};
