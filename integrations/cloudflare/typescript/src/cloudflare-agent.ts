import { AbstractAgent, type RunAgentInput, type BaseEvent } from "@ag-ui/client";
import { Observable, Subscriber } from "rxjs";
import { v4 as uuidv4 } from "uuid";
import { CloudflareAIClient } from "./client";
import type { CloudflareAIConfig, CloudflareMessage, CloudflareCompletionOptions } from "./types";
import {
  EventType,
  type TextMessageStartEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type RunStartedEvent,
  type RunFinishedEvent,
} from "@ag-ui/core";

export interface CloudflareAgentConfig extends CloudflareAIConfig {
  systemPrompt?: string;
  streamingEnabled?: boolean;
}

/**
 * Base agent class for Cloudflare Workers AI integration with AG-UI protocol.
 *
 * This class properly extends AbstractAgent and emits events conforming to the
 * AG-UI protocol specifications.
 */
export class CloudflareAgent extends AbstractAgent {
  protected client: CloudflareAIClient;
  protected config: CloudflareAgentConfig;

  constructor(config: CloudflareAgentConfig) {
    super({
      description: `Cloudflare Workers AI Agent using ${config.model}`,
    });
    this.config = config;
    this.client = new CloudflareAIClient(config);
  }

  /**
   * Implements the abstract run() method from AbstractAgent.
   * Returns an Observable<BaseEvent> as required by the AG-UI protocol.
   */
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      this.executeRun(input, subscriber)
        .catch((error) => {
          console.error("CloudflareAgent execution error:", error);
          subscriber.error(error);
        })
        .finally(() => {
          subscriber.complete();
        });
    });
  }

  /**
   * Main execution logic that streams events to the subscriber.
   */
  protected async executeRun(
    input: RunAgentInput,
    subscriber: Subscriber<BaseEvent>
  ): Promise<void> {
    const messageId = this.generateMessageId();

    // Emit RUN_STARTED
    const runStarted: RunStartedEvent = {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
      timestamp: Date.now(),
    };
    subscriber.next(runStarted);

    // Convert AG-UI messages to Cloudflare format
    const messages = this.convertMessagesToCloudflare(input.messages);

    // Add system prompt if configured
    const allMessages = this.config.systemPrompt
      ? [{ role: "system" as const, content: this.config.systemPrompt }, ...messages]
      : messages;

    // Prepare completion options
    const completionOptions: CloudflareCompletionOptions = {
      messages: allMessages,
      model: this.config.model,
      stream: this.config.streamingEnabled !== false,
      tools: input.tools && input.tools.length > 0 ? this.convertTools(input.tools) : undefined,
    };

    // Stream from Cloudflare Workers AI
    if (this.config.streamingEnabled !== false) {
      await this.handleStreaming(messageId, completionOptions, subscriber);
    } else {
      await this.handleNonStreaming(messageId, completionOptions, subscriber);
    }

    // Emit RUN_FINISHED
    const runFinished: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
      timestamp: Date.now(),
    };
    subscriber.next(runFinished);
  }

  /**
   * Handles streaming completion from Cloudflare Workers AI.
   */
  protected async handleStreaming(
    messageId: string,
    options: CloudflareCompletionOptions,
    subscriber: Subscriber<BaseEvent>
  ): Promise<void> {
    let messageStarted = false;
    let accumulatedContent = "";
    const toolCallsInProgress = new Map<string, string>();

    for await (const chunk of this.client.streamComplete(options)) {
      // Handle text content
      if (chunk.response && chunk.response.length > 0) {
        if (!messageStarted) {
          // Emit TEXT_MESSAGE_START
          const textStart: TextMessageStartEvent = {
            type: EventType.TEXT_MESSAGE_START,
            messageId,
            role: "assistant",
            timestamp: Date.now(),
          };
          subscriber.next(textStart);
          messageStarted = true;
        }

        // Emit TEXT_MESSAGE_CONTENT
        const textContent: TextMessageContentEvent = {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: chunk.response,
          timestamp: Date.now(),
        };
        subscriber.next(textContent);

        accumulatedContent += chunk.response;
      }

      // Handle tool calls
      if (chunk.tool_calls) {
        for (const toolCall of chunk.tool_calls) {
          if (!toolCallsInProgress.has(toolCall.id)) {
            // New tool call - emit TOOL_CALL_START
            const toolStart: ToolCallStartEvent = {
              type: EventType.TOOL_CALL_START,
              toolCallId: toolCall.id,
              toolCallName: toolCall.function.name,
              parentMessageId: messageId,
              timestamp: Date.now(),
            };
            subscriber.next(toolStart);
            toolCallsInProgress.set(toolCall.id, "");
          }

          // Stream tool call arguments - emit TOOL_CALL_ARGS
          if (toolCall.function.arguments) {
            const toolArgs: ToolCallArgsEvent = {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: toolCall.id,
              delta: toolCall.function.arguments,
              timestamp: Date.now(),
            };
            subscriber.next(toolArgs);
          }
        }
      }

      // Handle completion
      if (chunk.done) {
        // End text message if it was started
        if (messageStarted) {
          const textEnd: TextMessageEndEvent = {
            type: EventType.TEXT_MESSAGE_END,
            messageId,
            timestamp: Date.now(),
          };
          subscriber.next(textEnd);
        }

        // End all tool calls
        for (const [toolCallId] of toolCallsInProgress) {
          const toolEnd: ToolCallEndEvent = {
            type: EventType.TOOL_CALL_END,
            toolCallId,
            timestamp: Date.now(),
          };
          subscriber.next(toolEnd);
        }
      }
    }
  }

  /**
   * Handles non-streaming completion from Cloudflare Workers AI.
   */
  protected async handleNonStreaming(
    messageId: string,
    options: CloudflareCompletionOptions,
    subscriber: Subscriber<BaseEvent>
  ): Promise<void> {
    const response = await this.client.complete(options);

    // Emit text message events
    if (response.content) {
      const textStart: TextMessageStartEvent = {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
        timestamp: Date.now(),
      };
      subscriber.next(textStart);

      const textContent: TextMessageContentEvent = {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: response.content,
        timestamp: Date.now(),
      };
      subscriber.next(textContent);

      const textEnd: TextMessageEndEvent = {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        timestamp: Date.now(),
      };
      subscriber.next(textEnd);
    }

    // Emit tool call events
    if (response.tool_calls) {
      for (const toolCall of response.tool_calls) {
        const toolStart: ToolCallStartEvent = {
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCall.id,
          toolCallName: toolCall.function.name,
          parentMessageId: messageId,
          timestamp: Date.now(),
        };
        subscriber.next(toolStart);

        const toolArgs: ToolCallArgsEvent = {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCall.id,
          delta: toolCall.function.arguments,
          timestamp: Date.now(),
        };
        subscriber.next(toolArgs);

        const toolEnd: ToolCallEndEvent = {
          type: EventType.TOOL_CALL_END,
          toolCallId: toolCall.id,
          timestamp: Date.now(),
        };
        subscriber.next(toolEnd);
      }
    }
  }

  /**
   * Converts AG-UI messages to Cloudflare format.
   */
  protected convertMessagesToCloudflare(messages: any[]): CloudflareMessage[] {
    return messages
      .filter(
        (msg) => msg.role === "user" || msg.role === "assistant" || msg.role === "system"
      )
      .map((msg) => ({
        role: msg.role as "user" | "assistant" | "system",
        content: msg.content || "",
      }));
  }

  /**
   * Converts AG-UI tools to Cloudflare format.
   */
  protected convertTools(tools: any[]): any[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /**
   * Generates a unique message ID for AG-UI events.
   */
  protected generateMessageId(): string {
    return uuidv4();
  }
}
