import { HttpAgent, HttpAgentConfig, FetchRunHistoryOptions, FetchRunHistoryResult, Message } from "@ag-ui/client";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

export * from './agent'

export interface LangGraphHttpAgentConfig extends HttpAgentConfig {
  checkpointer?: BaseCheckpointSaver;
}

export class LangGraphHttpAgent extends HttpAgent {
  protected checkpointer?: BaseCheckpointSaver;

  constructor(config: LangGraphHttpAgentConfig) {
    super(config);
    this.checkpointer = config.checkpointer;
  }

  protected async fetchRunHistory(
    options: FetchRunHistoryOptions
  ): Promise<FetchRunHistoryResult | undefined> {
    if (!this.checkpointer) {
      return undefined;
    }

    try {
      const { threadId } = options;

      // Get checkpoints from the checkpointer
      const checkpoints = [];
      for await (const checkpoint of this.checkpointer.list({ configurable: { thread_id: threadId } })) {
        checkpoints.push(checkpoint);
      }

      if (checkpoints.length === 0) {
        return { runs: [] };
      }

      // Get the latest checkpoint with full state
      const tuple = await this.checkpointer.getTuple({ configurable: { thread_id: threadId } });

      if (!tuple?.checkpoint) {
        return { runs: [] };
      }

      // Extract and convert messages
      const channelValues = tuple.checkpoint.channel_values || {};
      const messages = (channelValues as Record<string, unknown>).messages || [];
      const aguiMessages = this.convertMessages(messages as unknown[]);

      return {
        runs: [{
          runId: (tuple.config?.configurable as Record<string, unknown>)?.checkpoint_id as string || threadId,
          messages: aguiMessages,
        }]
      };
    } catch (error) {
      console.error("Failed to fetch run history from checkpointer:", error);
      return undefined;
    }
  }

  private convertMessages(messages: unknown[]): Message[] {
    return messages.map((msg) => this.convertMessage(msg)).filter(Boolean) as Message[];
  }

  private convertMessage(msg: unknown): Message | null {
    const message = msg as Record<string, unknown>;
    const getType = message._getType as (() => string) | undefined;
    const role = this.mapRole(getType?.() || (message.type as string));
    if (!role) return null;

    const content = message.content;
    const toolCalls = message.tool_calls as Array<{ id: string; name: string; args: unknown }> | undefined;

    const baseMessage = {
      id: (message.id as string) || crypto.randomUUID(),
      role,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    };

    if (role === 'tool' && message.tool_call_id) {
      return {
        ...baseMessage,
        role: 'tool' as const,
        toolCallId: message.tool_call_id as string,
      };
    }

    if (role === 'assistant' && toolCalls?.length) {
      return {
        ...baseMessage,
        role: 'assistant' as const,
        toolCalls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          },
        })),
      };
    }

    if (role === 'user') {
      return {
        ...baseMessage,
        role: 'user' as const,
        content: baseMessage.content,
      };
    }

    if (role === 'system') {
      return {
        ...baseMessage,
        role: 'system' as const,
        content: baseMessage.content,
      };
    }

    if (role === 'developer') {
      return {
        ...baseMessage,
        role: 'developer' as const,
        content: baseMessage.content,
      };
    }

    return null;
  }

  private mapRole(type: string): string | null {
    switch (type) {
      case 'human': return 'user';
      case 'ai': return 'assistant';
      case 'system': return 'system';
      case 'tool': return 'tool';
      default: return null;
    }
  }

  public clone(): LangGraphHttpAgent {
    const cloned = super.clone() as LangGraphHttpAgent;
    cloned.checkpointer = this.checkpointer;
    return cloned;
  }
}
