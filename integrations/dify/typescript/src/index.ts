import {
  AbstractAgent,
  RunAgentInput,
  EventType,
  Tool,
  randomUUID,
  BaseEvent,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
} from "@ag-ui/client";
import { Observable, from } from "rxjs";
import { DifyClientConfig, DifyStreamResponse } from "./types";
import { aguiMessagesToDify } from "./utils";

/**
 * DifyAgent - AG-UI integration for Dify
 *
 * This agent connects to the Dify platform to provide agentic chat capabilities.
 * It supports streaming responses from Dify's chat-messages API endpoint.
 *
 * Properties must be public for Next.js serialization to preserve them.
 *
 * @example
 * ```ts
 * const agent = new DifyAgent({
 *   apiKey: process.env.DIFY_API_KEY,
 *   baseUrl: "https://api.dify.ai/v1"
 * });
 * ```
 */
export class DifyAgent extends AbstractAgent {
  /** Dify API key for authentication */
  public apiKey: string;
  /** Base URL for the Dify API */
  public baseUrl: string;

  /**
   * Creates a new DifyAgent instance
   * @param config - Configuration object containing API key and optional base URL
   * @throws {Error} If API key is missing or invalid
   * @throws {Error} If base URL is not using HTTPS (for non-local URLs)
   */
  constructor(config: DifyClientConfig) {
    super();
    // Validate API key
    if (!config.apiKey || typeof config.apiKey !== "string" || config.apiKey.trim() === "") {
      throw new Error("DifyAgent: apiKey must be a non-empty string");
    }

    // Validate and set baseUrl
    const baseUrl = config.baseUrl || "https://api.dify.ai/v1";
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
      throw new Error("DifyAgent: baseUrl must be a non-empty string");
    }

    // Enforce HTTPS for non-local URLs
    if (baseUrl.startsWith("http://") && !baseUrl.includes("localhost") && !baseUrl.includes("127.0.0.1")) {
      throw new Error("DifyAgent: baseUrl must use HTTPS for non-local URLs");
    }

    // Store primitive values - must be public for serialization
    this.apiKey = config.apiKey.trim();
    this.baseUrl = baseUrl.trim().replace(/\/$/, ""); // Remove trailing slash
  }

  /**
   * Runs the agent with the given input and returns a stream of AG-UI events
   *
   * This method sends the last user message from the input to Dify's chat API
   * and streams the response back as AG-UI text message events.
   *
   * @param input - Agent run input containing messages, thread ID, and run ID
   * @returns Observable of AG-UI events including RUN_STARTED, TEXT_MESSAGE_*, and RUN_FINISHED
   * @throws {Error} If configuration was lost during serialization
   *
   * @example
   * ```ts
   * agent.run({
   *   messages: [{ role: "user", content: "Hello!" }],
   *   threadId: "thread-123",
   *   runId: "run-456"
   * }).subscribe({
   *   next: (event) => console.log(event),
   *   complete: () => console.log("Done"),
   *   error: (err) => console.error(err)
   * });
   * ```
   */
  run(input: RunAgentInput): Observable<BaseEvent> {
    return from(this.stream(input));
  }

  /**
   * Internal async generator that streams AG-UI events from Dify API
   *
   * @param input - Agent run input containing messages, thread ID, and run ID
   * @returns AsyncGenerator of AG-UI events
   * @internal
   */
  async *stream(input: RunAgentInput): AsyncGenerator<BaseEvent> {
    // Validate that config wasn't lost during serialization
    if (!this.apiKey || !this.baseUrl) {
      const error: RunErrorEvent = {
        type: EventType.RUN_ERROR,
        message: "DifyAgent: Configuration was lost during serialization. Please ensure the agent is properly initialized.",
      };
      yield error;
      throw new Error(error.message);
    }

    // 1. Send AG-UI event: Run started
    const runStartedEvent: RunStartedEvent = {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    };
    yield runStartedEvent;

    // 2. Convert AG-UI messages to Dify format
    const difyMessages = aguiMessagesToDify(input.messages);
    const difyTools = input.tools?.map((tool: Tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    // 3. Track message and tool call state
    let currentMessageId: string | undefined;
    const toolCallState = new Map<string, { name: string; args: string }>();

    try {
      // 4. Call Dify streaming chat API directly (no client instance)
      const url = `${this.baseUrl}/chat-messages`;
      const lastUserMessage = [...difyMessages].reverse().find((msg: { role: string }) => msg.role === 'user');

      // Convert AG-UI tools to Dify format (OpenAI-compatible function calling)
      const tools = input.tools?.map((tool: Tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));

      const body: Record<string, unknown> = {
        inputs: {},
        query: lastUserMessage?.content || '',
        response_mode: "streaming",
        conversation_id: "",
        user: "ag-ui-user",
      };

      // Only add tools if there are any defined
      if (tools && tools.length > 0) {
        body.tools = tools;
      }

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Dify API error: ${response.status} ${response.statusText}: ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Failed to get response reader");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim() === "" || !line.startsWith("data: ")) {
            continue;
          }

          try {
            const chunk = JSON.parse(line.slice(6)) as DifyStreamResponse;

            switch (chunk.event) {
              case "message":
              case "agent_message":
                if (!currentMessageId) {
                  currentMessageId = chunk.message_id || randomUUID();
                  yield {
                    type: EventType.TEXT_MESSAGE_START,
                    messageId: currentMessageId,
                    role: "assistant",
                  } as TextMessageStartEvent;
                }
                if (chunk.answer) {
                  yield {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: currentMessageId!,
                    delta: chunk.answer,
                  } as TextMessageContentEvent;
                }
                break;

              case "agent_thought": {
                // Handle tool calls from Dify
                const thought = chunk as any;

                // Only process tool calls (when tool_input is present), skip observations (tool results)
                // Dify sends agent_thought twice: once with tool_input (the call), once with observation (the result)
                if (thought.tool && thought.tool_input && !thought.observation) {
                  const toolCallId = thought.id || randomUUID();
                  const toolName = thought.tool;

                  // Parse tool_input which is a JSON string
                  let toolArgs = thought.tool_input;
                  try {
                    // Clean up the JSON string - replace various invalid characters
                    let cleanedInput = thought.tool_input
                      // Smart double quotes
                      .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036]/g, '"')
                      // Smart single quotes
                      .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, "'")
                      // Full-width commas to regular commas
                      .replace(/[\uFF0C]/g, ',')
                      // Full-width brackets to regular brackets
                      .replace(/[\uFF08]/g, '(')
                      .replace(/[\uFF09]/g, ')')
                      .replace(/[\uFF3B]/g, '[')
                      .replace(/[\uFF3D]/g, ']')
                      .replace(/[\uFF5B]/g, '{')
                      .replace(/[\uFF5D]/g, '}')
                      // Full-width colons
                      .replace(/[\uFF1A]/g, ':');

                    const parsedInput = JSON.parse(cleanedInput);
                    // The actual arguments are nested under the tool name
                    if (parsedInput[toolName]) {
                      toolArgs = JSON.stringify(parsedInput[toolName]);
                    }
                  } catch {
                    // Keep tool_input as-is if parsing fails
                  }

                  yield {
                    type: EventType.TOOL_CALL_START,
                    parentMessageId: currentMessageId || thought.message_id || randomUUID(),
                    toolCallId,
                    toolCallName: toolName,
                  } as ToolCallStartEvent;

                  yield {
                    type: EventType.TOOL_CALL_ARGS,
                    toolCallId,
                    delta: toolArgs,
                  } as ToolCallArgsEvent;

                  yield {
                    type: EventType.TOOL_CALL_END,
                    toolCallId,
                  } as ToolCallEndEvent;
                }
                break;
              }

              case "message_end":
              case "agent_message_end":
                if (currentMessageId) {
                  yield {
                    type: EventType.TEXT_MESSAGE_END,
                    messageId: currentMessageId,
                  } as TextMessageEndEvent;
                }
                break;
            }
          } catch (e) {
            // Silently skip unparseable chunks
          }
        }
      }

      // Send run finished event
      yield {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as RunFinishedEvent;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorEvent: RunErrorEvent = {
        type: EventType.RUN_ERROR,
        message: errorMessage,
      };
      yield errorEvent;
      throw error;
    }
  }

  /**
   * Clones this agent with the same configuration
   *
   * Required for proper serialization in Next.js/CopilotKit.
   *
   * @returns A new DifyAgent instance with the same API key and base URL
   */
  public clone(): DifyAgent {
    const cloned = new DifyAgent({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
    });
    return cloned;
  }
}

// Export types for external use
export * from "./types";
export * from "./utils";
