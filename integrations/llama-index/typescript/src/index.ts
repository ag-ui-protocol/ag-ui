/**
 * LlamaIndex is a simple, flexible framework for building agentic generative AI applications that allow large language models to work with your data in any format.
 * Check more about using LlamaIndex: https://docs.llamaindex.ai/
 */

import { HttpAgent } from "@ag-ui/client";
import { contentHasMedia, contentToText } from "@ag-ui/core";
import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";

/**
 * Normalizes AG-UI tool result messages before sending them to the LlamaIndex server.
 *
 * Context: When a frontend tool returns `undefined`, upstream encoders serialize the
 * result as an empty string (""). Some LlamaIndex workflows treat an empty tool
 * result as insufficient evidence and immediately re-plan the same tool call,
 * which can produce repeated frontend tool invocations (e.g., duplicate alerts).
 *
 * This integration adapts those messages for LlamaIndex by converting empty tool
 * results into a non-empty canonical value ("ok"). This preserves semantics for
 * tools that return no meaningful payload while preventing the planner from
 * needlessly re-invoking the same tool.
 */
function normalizeEmptyToolResults(messages: Message[]): Message[] {
  return messages.map((message: Message): Message => {
    if (message.role === "tool") {
      // Content is a string or a list of parts; a result that carries media
      // is not empty however little text it has.
      const isEmpty: boolean =
        !contentHasMedia(message.content) &&
        contentToText(message.content).trim().length === 0;
      if (isEmpty) {
        return { ...message, content: "ok" };
      }
    }
    return message;
  });
}

export class LlamaIndexAgent extends HttpAgent {
  public override run(input: RunAgentInput): Observable<BaseEvent> {
    const sanitizedInput: RunAgentInput = {
      ...input,
      messages: normalizeEmptyToolResults(input.messages),
    };
    return super.run(sanitizedInput);
  }
}
