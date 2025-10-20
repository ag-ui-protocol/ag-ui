import { CloudflareAIClient } from "./client";
import {
  EventType,
  type BaseEvent,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type TextMessageStartEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type CustomEvent,
} from "@ag-ui/core";
import { CloudflareAIConfig, CloudflareMessage, CloudflareModel, Tool, CloudflareCompletionOptions } from "./types";
import type {
  CopilotRuntimeChatCompletionRequest,
  CopilotRuntimeChatCompletionResponse,
  CopilotServiceAdapter,
} from "@copilotkit/runtime";
import { v4 as uuidv4 } from "uuid";

export interface CloudflareAGUIAdapterOptions extends CloudflareAIConfig {
  systemPrompt?: string;
  tools?: Tool[];
  streamingEnabled?: boolean;
}

export interface AGUIProtocol {
  execute(messages: CloudflareMessage[], context?: Record<string, any>): AsyncGenerator<BaseEvent>;
}

export type StreamableResult<T> = AsyncGenerator<T>;

export class CloudflareAGUIAdapter implements AGUIProtocol, CopilotServiceAdapter {
  private client: CloudflareAIClient;
  private options: CloudflareAGUIAdapterOptions;
  private runCounter = 0;

  constructor(options: CloudflareAGUIAdapterOptions) {
    this.options = options;
    this.client = new CloudflareAIClient(options);
  }

  // CopilotKit ServiceAdapter interface implementation
  // CopilotKit v1.10+ expects adapters to handle streaming - it doesn't do it automatically
  async process(
    request: CopilotRuntimeChatCompletionRequest,
  ): Promise<CopilotRuntimeChatCompletionResponse> {
    // Generate a unique thread ID if not provided
    const threadId =
      request.threadId || `thread-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const runId = this.generateRunId();

    // Convert CopilotKit messages to Cloudflare format
    // Note: Using any here because CopilotKit Message type may vary between versions
    const messages: CloudflareMessage[] = request.messages.map((msg: any) => ({
      role: msg.role as "user" | "assistant" | "system",
      content: msg.content || msg.text || "",
    }));

    // Reuse the execute() streaming logic to maintain consistent behavior
    // This ensures CopilotKit receives proper AG-UI event streams
    const stream = this.execute(messages, { threadId, runId });

    // Return response with stream - CopilotKit will consume these events
    // and maintain thread state based on the threadId/runId in the events
    return {
      threadId,
      runId,
      stream, // ✅ Stream AG-UI events to CopilotKit
    } as CopilotRuntimeChatCompletionResponse;
  }

  async *execute(
    messages: CloudflareMessage[],
    context?: Record<string, any>,
  ): AsyncGenerator<BaseEvent> {
    const threadId = context?.threadId || `thread-${Date.now()}`;
    const runId = context?.runId || this.generateRunId();

    try {
      // Emit run started event
      const runStarted: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        threadId,
        runId,
        timestamp: Date.now(),
      };
      yield runStarted;

      // Add system prompt if configured
      const allMessages = this.options.systemPrompt
        ? [{ role: "system" as const, content: this.options.systemPrompt }, ...messages]
        : messages;

      const completionOptions: CloudflareCompletionOptions = {
        messages: allMessages,
        model: this.options.model,
        tools: this.options.tools,
        stream: this.options.streamingEnabled !== false,
      };

      if (this.options.streamingEnabled !== false) {
        yield* this.handleStreaming(completionOptions);
      } else {
        yield* this.handleNonStreaming(completionOptions);
      }

      // Emit run finished event
      const runFinished: RunFinishedEvent = {
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        timestamp: Date.now(),
      };
      yield runFinished;
    } catch (error) {
      // ✅ Enhanced error logging with full context
      console.error("CloudflareAGUIAdapter execution error:", {
        threadId,
        runId,
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name,
        } : error,
        timestamp: new Date().toISOString(),
      });

      // Emit error event
      const runError: RunErrorEvent = {
        type: EventType.RUN_ERROR,
        message: error instanceof Error ? error.message : "Unknown error",
        timestamp: Date.now(),
      };
      yield runError;
      throw error;
    }
  }

  private async *handleStreaming(
    options: CloudflareCompletionOptions,
  ): AsyncGenerator<BaseEvent> {
    let messageStarted = false;
    let currentMessageId: string | null = null;
    const toolCallsInProgress = new Set<string>();
    let messageEnded = false;

    for await (const chunk of this.client.streamComplete(options)) {
      // Handle text content
      if (chunk.response) {
        if (!messageStarted) {
          currentMessageId = uuidv4();
          const textStart: TextMessageStartEvent = {
            type: EventType.TEXT_MESSAGE_START,
            messageId: currentMessageId,
            role: "assistant",
            timestamp: Date.now(),
          };
          yield textStart;
          messageStarted = true;
          messageEnded = false;
        }
        const textContent: TextMessageContentEvent = {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: currentMessageId!,
          delta: chunk.response,
          timestamp: Date.now(),
        };
        yield textContent;
      }

      // Handle tool calls
      if (chunk.tool_calls) {
        for (const toolCall of chunk.tool_calls) {
          const toolCallId = toolCall.id ?? "";
          const toolName = toolCall.function?.name ?? "tool";

          if (!toolCallId) {
            continue;
          }

          if (!toolCallsInProgress.has(toolCallId)) {
            // New tool call
            const toolStart: ToolCallStartEvent = {
              type: EventType.TOOL_CALL_START,
              toolCallId,
              toolCallName: toolName,
              timestamp: Date.now(),
            };
            yield toolStart;
            toolCallsInProgress.add(toolCallId);
          }

          // Stream tool call arguments
          const rawArguments = toolCall.function?.arguments;
          if (rawArguments !== undefined && rawArguments !== null) {
            const args =
              typeof rawArguments === "string"
                ? rawArguments
                : JSON.stringify(rawArguments);

            if (args.length > 0) {
              const toolArgs: ToolCallArgsEvent = {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId,
                delta: args,
                timestamp: Date.now(),
              };
              yield toolArgs;
            }
          }
        }
      }

      // Handle completion
      if (chunk.done) {
        if (messageStarted && currentMessageId) {
          if (!messageEnded) {
            const textEnd: TextMessageEndEvent = {
              type: EventType.TEXT_MESSAGE_END,
              messageId: currentMessageId,
              timestamp: Date.now(),
            };
            yield textEnd;
            messageEnded = true;
          }
          messageStarted = false;
        }

        // End all tool calls
        for (const toolCallId of toolCallsInProgress) {
          const toolEnd: ToolCallEndEvent = {
            type: EventType.TOOL_CALL_END,
            toolCallId,
            timestamp: Date.now(),
          };
          yield toolEnd;
        }
        toolCallsInProgress.clear();

        // Emit usage metadata if available
        if (chunk.usage) {
          const metadata: CustomEvent = {
            type: EventType.CUSTOM,
            name: "usage_metadata",
            value: {
              usage: chunk.usage,
              model: options.model,
            },
            timestamp: Date.now(),
          };
          yield metadata;
        }
      }
    }
  }

  private async *handleNonStreaming(
    options: CloudflareCompletionOptions,
  ): AsyncGenerator<BaseEvent> {
    const response = await this.client.complete(options);

    // Emit text message events
    if (response.content) {
      const messageId = uuidv4();

      const textStart: TextMessageStartEvent = {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
        timestamp: Date.now(),
      };
      yield textStart;

      const textContent: TextMessageContentEvent = {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: response.content,
        timestamp: Date.now(),
      };
      yield textContent;

      const textEnd: TextMessageEndEvent = {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        timestamp: Date.now(),
      };
      yield textEnd;
    }

    // Emit tool call events
    if (response.tool_calls) {
      for (const toolCall of response.tool_calls) {
        const toolStart: ToolCallStartEvent = {
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCall.id,
          toolCallName: toolCall.function.name,
          timestamp: Date.now(),
        };
        yield toolStart;

        const args =
          typeof toolCall.function.arguments === "string"
            ? toolCall.function.arguments
            : JSON.stringify(toolCall.function.arguments);

        const toolArgs: ToolCallArgsEvent = {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCall.id,
          delta: args,
          timestamp: Date.now(),
        };
        yield toolArgs;

        const toolEnd: ToolCallEndEvent = {
          type: EventType.TOOL_CALL_END,
          toolCallId: toolCall.id,
          timestamp: Date.now(),
        };
        yield toolEnd;
      }
    }
  }

  async *executeWithTools(
    messages: CloudflareMessage[],
    tools: Tool[],
    context?: Record<string, any>,
  ): AsyncGenerator<BaseEvent> {
    const updatedOptions = { ...this.options, tools };
    const adapter = new CloudflareAGUIAdapter(updatedOptions);
    yield* adapter.execute(messages, context);
  }

  async *progressiveGeneration(
    prompt: string,
    stages: Array<{ name: string; instruction: string }>,
  ): AsyncGenerator<BaseEvent> {
    const threadId = `thread-${Date.now()}`;
    const runId = this.generateRunId();

    const runStarted: RunStartedEvent = {
      type: EventType.RUN_STARTED,
      threadId,
      runId,
      timestamp: Date.now(),
    };
    yield runStarted;

    let allContent = "";
    const totalStages = stages.length;

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];

      // Emit progress event
      const progress: CustomEvent = {
        type: EventType.CUSTOM,
        name: "progress",
        value: {
          progress: ((i + 1) / totalStages) * 100,
          message: `Processing: ${stage.name}`,
        },
        timestamp: Date.now(),
      };
      yield progress;

      // Build progressive prompt with context from previous stages
      const stagePrompt =
        i === 0
          ? `${prompt}\n\n${stage.instruction}`
          : `${prompt}\n\nPrevious research/content:\n${allContent}\n\nNow, ${stage.instruction}`;

      const messages: CloudflareMessage[] = [{ role: "user", content: stagePrompt }];

      // Configure completion options
      const completionOptions: CloudflareCompletionOptions = {
        messages,
        model: this.options.model,
        stream: true,
      };

      // Generate content for this stage
      const messageId = uuidv4();
      const textStart: TextMessageStartEvent = {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
        timestamp: Date.now(),
      };
      yield textStart;

      let stageContent = "";

      // Stream content directly from Cloudflare
      for await (const chunk of this.client.streamComplete(completionOptions)) {
        if (chunk.response) {
          const textContent: TextMessageContentEvent = {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: chunk.response,
            timestamp: Date.now(),
          };
          yield textContent;
          stageContent += chunk.response;
        }

        if (chunk.done && chunk.usage) {
          const metadata: CustomEvent = {
            type: EventType.CUSTOM,
            name: "stage_metadata",
            value: {
              stage: stage.name,
              usage: chunk.usage,
            },
            timestamp: Date.now(),
          };
          yield metadata;
        }
      }

      allContent += `\n\n## ${stage.name}\n\n${stageContent}`;

      const textEnd: TextMessageEndEvent = {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        timestamp: Date.now(),
      };
      yield textEnd;
    }

    const runFinished: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
      timestamp: Date.now(),
    };
    yield runFinished;
  }

  setModel(model: CloudflareModel): void {
    this.options.model = model;
  }

  getCapabilities() {
    return this.client.getModelCapabilities(this.options.model || "@cf/meta/llama-3.1-8b-instruct");
  }

  async listAvailableModels(): Promise<string[]> {
    return this.client.listModels();
  }

  private generateRunId(): string {
    return `cf-run-${Date.now()}-${++this.runCounter}`;
  }
}
