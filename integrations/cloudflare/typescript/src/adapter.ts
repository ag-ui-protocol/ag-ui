import { CloudflareAIClient } from "./client";
import { CloudflareAGUIEvents, AGUIEvent, EventType } from "./events";
import { CloudflareAIConfig, CloudflareMessage, Tool, CloudflareCompletionOptions } from "./types";
import type {
  CopilotRuntimeChatCompletionRequest,
  CopilotRuntimeChatCompletionResponse,
  CopilotServiceAdapter,
} from "@copilotkit/runtime";

export interface CloudflareAGUIAdapterOptions extends CloudflareAIConfig {
  systemPrompt?: string;
  tools?: Tool[];
  streamingEnabled?: boolean;
}

export interface AGUIProtocol {
  execute(messages: any[], context?: Record<string, any>): AsyncGenerator<AGUIEvent>;
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
  async process(
    request: CopilotRuntimeChatCompletionRequest,
  ): Promise<CopilotRuntimeChatCompletionResponse> {
    // Generate a unique thread ID if not provided
    const threadId =
      request.threadId || `thread-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const runId = this.generateRunId();

    try {
      // Convert CopilotKit messages to Cloudflare format
      const messages: CloudflareMessage[] = request.messages.map((msg: any) => ({
        role: msg.role as "user" | "assistant" | "system",
        content: msg.content || msg.text || "",
      }));

      // Add system prompt if configured
      const allMessages = this.options.systemPrompt
        ? [{ role: "system" as const, content: this.options.systemPrompt }, ...messages]
        : messages;

      // Create completion options
      const completionOptions: CloudflareCompletionOptions = {
        messages: allMessages,
        model: this.options.model, // Use configured model, ignoring request.model as it may not match Cloudflare's model types
        tools: this.options.tools,
        stream: false, // CopilotKit handles streaming separately
      };

      // Get the completion from Cloudflare
      await this.client.complete(completionOptions);

      // Return response in CopilotKit format
      return {
        threadId,
        runId,
        extensions: {},
      };
    } catch (error) {
      console.error("Error in CloudflareAGUIAdapter.process:", error);
      throw error;
    }
  }

  async *execute(
    messages: CloudflareMessage[],
    context?: Record<string, any>,
  ): AsyncGenerator<AGUIEvent> {
    const runId = this.generateRunId();

    try {
      // Emit run started event
      yield CloudflareAGUIEvents.runStarted(runId, {
        model: this.options.model,
        messageCount: messages.length,
        ...context,
      });

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
        yield* this.handleStreaming(runId, completionOptions);
      } else {
        yield* this.handleNonStreaming(runId, completionOptions);
      }

      // Emit run finished event
      yield CloudflareAGUIEvents.runFinished(runId);
    } catch (error) {
      // Emit error event
      yield CloudflareAGUIEvents.error(runId, error as Error);
      throw error;
    }
  }

  private async *handleStreaming(
    runId: string,
    options: CloudflareCompletionOptions,
  ): AsyncGenerator<AGUIEvent> {
    let messageStarted = false;
    let toolCallsInProgress = new Map<string, string>();
    let accumulatedContent = "";

    yield CloudflareAGUIEvents.textMessageStart(runId, "assistant");
    messageStarted = true;

    for await (const chunk of this.client.streamComplete(options)) {
      // Handle text content
      if (chunk.response) {
        if (!messageStarted) {
          yield CloudflareAGUIEvents.textMessageStart(runId, "assistant");
          messageStarted = true;
        }
        yield CloudflareAGUIEvents.textMessageContent(runId, chunk.response);
        accumulatedContent += chunk.response;
      }

      // Handle tool calls
      if (chunk.tool_calls) {
        for (const toolCall of chunk.tool_calls) {
          if (!toolCallsInProgress.has(toolCall.id)) {
            // New tool call
            yield CloudflareAGUIEvents.toolCallStart(runId, toolCall.id, toolCall.function.name);
            toolCallsInProgress.set(toolCall.id, "");
          }

          // Stream tool call arguments
          yield CloudflareAGUIEvents.toolCallArgs(runId, toolCall.id, toolCall.function.arguments);
        }
      }

      // Handle completion
      if (chunk.done) {
        if (messageStarted) {
          yield CloudflareAGUIEvents.textMessageEnd(runId);
        }

        // End all tool calls
        for (const [toolCallId] of toolCallsInProgress) {
          yield CloudflareAGUIEvents.toolCallEnd(runId, toolCallId);
        }

        // Emit usage metadata if available
        if (chunk.usage) {
          yield CloudflareAGUIEvents.metadata(runId, {
            usage: chunk.usage,
            model: options.model,
          });
        }
      }
    }
  }

  private async *handleNonStreaming(
    runId: string,
    options: CloudflareCompletionOptions,
  ): AsyncGenerator<AGUIEvent> {
    const response = await this.client.complete(options);

    // Emit text message events
    if (response.content) {
      yield CloudflareAGUIEvents.textMessageStart(runId, "assistant");
      yield CloudflareAGUIEvents.textMessageContent(runId, response.content);
      yield CloudflareAGUIEvents.textMessageEnd(runId);
    }

    // Emit tool call events
    if (response.tool_calls) {
      for (const toolCall of response.tool_calls) {
        yield CloudflareAGUIEvents.toolCallStart(runId, toolCall.id, toolCall.function.name);
        yield CloudflareAGUIEvents.toolCallArgs(runId, toolCall.id, toolCall.function.arguments);
        yield CloudflareAGUIEvents.toolCallEnd(runId, toolCall.id);
      }
    }
  }

  async *executeWithTools(
    messages: CloudflareMessage[],
    tools: Tool[],
    context?: Record<string, any>,
  ): AsyncGenerator<AGUIEvent> {
    const updatedOptions = { ...this.options, tools };
    const adapter = new CloudflareAGUIAdapter(updatedOptions);
    yield* adapter.execute(messages, context);
  }

  async *progressiveGeneration(
    prompt: string,
    stages: Array<{ name: string; instruction: string }>,
  ): AsyncGenerator<AGUIEvent> {
    const runId = this.generateRunId();

    yield CloudflareAGUIEvents.runStarted(runId, { stages: stages.length });

    let allContent = "";
    const totalStages = stages.length;

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];

      // Emit progress event
      yield CloudflareAGUIEvents.progress(
        runId,
        ((i + 1) / totalStages) * 100,
        `Processing: ${stage.name}`,
      );

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
      yield CloudflareAGUIEvents.textMessageStart(runId, "assistant");

      let stageContent = "";

      // Stream content directly from Cloudflare
      for await (const chunk of this.client.streamComplete(completionOptions)) {
        if (chunk.response) {
          const event = CloudflareAGUIEvents.textMessageContent(runId, chunk.response);
          yield event;
          stageContent += chunk.response;
        }

        if (chunk.done && chunk.usage) {
          yield CloudflareAGUIEvents.metadata(runId, {
            stage: stage.name,
            usage: chunk.usage,
          });
        }
      }

      allContent += `\n\n## ${stage.name}\n\n${stageContent}`;

      yield CloudflareAGUIEvents.textMessageEnd(runId);
    }

    yield CloudflareAGUIEvents.runFinished(runId);
  }

  setModel(model: string): void {
    this.options.model = model as any;
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
