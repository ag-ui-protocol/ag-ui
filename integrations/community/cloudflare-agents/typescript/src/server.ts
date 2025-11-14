/**
 * Server-side Cloudflare Agents integration
 *
 * Use this in your Cloudflare Worker to build agents that speak AG-UI protocol
 */

import { AIChatAgent } from "agents/ai-chat-agent";
import { type AgentContext } from "agents";
import { type StreamTextResult } from "ai";
import { Observable } from "rxjs";
import { AgentsToAGUIAdapter } from "./adapter";
import {
  type BaseEvent,
  type Message,
} from "@ag-ui/client";

/**
 * AG-UI-enabled Cloudflare Agent
 *
 * Extend this class in your Cloudflare Worker to build agents that:
 * - Run on Cloudflare Workers with Durable Objects
 * - Emit AG-UI protocol events
 * - Work with AG-UI clients
 *
 * @example
 * ```ts
 * import { AIChatAgentAGUI } from "@ag-ui/cloudflare-agents/server";
 *
 * export class MyAgent extends AIChatAgentAGUI {
 *   protected async generateResponse(messages: Message[]) {
 *     return streamText({
 *       model: openai("gpt-4"),
 *       messages
 *     });
 *   }
 * }
 * ```
 */
export class AIChatAgentAGUI<
  Env = unknown,
  State = unknown,
> extends AIChatAgent<Env, State> {
  private adapter: AgentsToAGUIAdapter;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.adapter = new AgentsToAGUIAdapter();
  }

  /**
   * Convert AI SDK stream to AG-UI events
   *
   * Override this method to emit AG-UI events from your agent
   */
  protected async *toAGUIEvents(
    stream: StreamTextResult<any, any>,
    threadId: string,
    runId: string,
    messages: Message[]
  ): AsyncGenerator<BaseEvent> {
    yield* this.adapter.adaptStreamToAGUI(stream, threadId, runId, messages);
  }

  /**
   * Override this to implement your AI response generation
   */
  protected async generateResponse(
    messages: Message[]
  ): Promise<StreamTextResult<any, any>> {
    throw new Error(
      "generateResponse must be implemented by your agent subclass"
    );
  }
}
