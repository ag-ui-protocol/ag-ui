import { Page, Route } from "@playwright/test";

/**
 * Deterministic mock agent for Playwright e2e tests.
 *
 * Intercepts CopilotKit API calls at the browser level and returns
 * pre-defined SSE responses. This allows testing UI behavior (background
 * color changes, regenerate, shared state) without depending on live LLM
 * responses, eliminating the primary source of test flakiness.
 *
 * Usage:
 *   const mock = new MockAgent(page);
 *   mock.onMessage("change the background color to blue", [
 *     MockAgent.toolCall("setBackgroundColor", { color: "blue" }),
 *     MockAgent.textMessage("I've changed the background color to blue."),
 *   ]);
 *   await mock.install();
 *   // ... run test ...
 *   await mock.uninstall();
 */

// AG-UI event types used in SSE responses
interface SSEEvent {
  type: string;
  [key: string]: unknown;
}

type ResponseSequence = SSEEvent[];

interface MessageHandler {
  pattern: string | RegExp;
  responses: ResponseSequence;
  once: boolean;
  used: boolean;
}

const ROUTE_PATTERN = /\/api\/copilotkit(next)?\/[^/]+/;

export class MockAgent {
  private page: Page;
  private handlers: MessageHandler[] = [];
  private fallbackResponse: ResponseSequence | null = null;
  private installed = false;
  private routeHandler: ((route: Route) => Promise<void>) | null = null;

  private runCounter = 0;
  private messageCounter = 0;
  private toolCallCounter = 0;

  constructor(page: Page) {
    this.page = page;
  }

  private nextRunId() {
    return `mock-run-${++this.runCounter}`;
  }

  private nextMessageId() {
    return `mock-msg-${++this.messageCounter}`;
  }

  private nextToolCallId() {
    return `mock-tc-${++this.toolCallCounter}`;
  }

  /**
   * Register a response for messages matching a pattern.
   */
  onMessage(
    pattern: string | RegExp,
    responses: ResponseSequence,
    options: { once?: boolean } = {}
  ): this {
    this.handlers.push({
      pattern,
      responses,
      once: options.once ?? false,
      used: false,
    });
    return this;
  }

  /**
   * Set a fallback response for unmatched messages.
   */
  onAnyMessage(responses: ResponseSequence): this {
    this.fallbackResponse = responses;
    return this;
  }

  /**
   * Install the route interceptor. Call before page.goto().
   */
  async install(): Promise<void> {
    if (this.installed) return;

    this.routeHandler = async (route: Route) => {
      const request = route.request();

      // Only intercept POST requests (SSE streams)
      if (request.method() !== "POST") {
        await route.continue();
        return;
      }

      try {
        let body: string;
        try {
          body = request.postData() ?? "";
        } catch (err) {
          console.warn("[MockAgent] Failed to read postData():", err instanceof Error ? err.message : err);
          body = "";
        }

        // Find the user's last message in the request body
        const lastUserMessage = this.extractLastUserMessage(body);
        const responses = this.findResponse(lastUserMessage);

        const sseBody = responses
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("");

        await route.fulfill({
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
          body: sseBody,
        });
      } catch (err) {
        console.error("[MockAgent] Route handler error:", err instanceof Error ? err.message : err);
        await route.abort("failed").catch(() => {});
      }
    };

    await this.page.route(ROUTE_PATTERN, this.routeHandler);
    this.installed = true;
  }

  /**
   * Remove the route interceptor.
   */
  async uninstall(): Promise<void> {
    if (!this.installed || !this.routeHandler) return;
    await this.page.unroute(ROUTE_PATTERN, this.routeHandler);
    this.routeHandler = null;
    this.installed = false;
  }

  private extractLastUserMessage(body: string): string {
    try {
      const parsed = JSON.parse(body);
      // CopilotKit v2 format: { body: { messages: [...] } }
      const messages =
        parsed?.body?.messages ?? parsed?.messages ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") {
          // Content can be a string or array of content parts
          const content = messages[i].content;
          if (typeof content === "string") return content;
          if (Array.isArray(content)) {
            const textPart = content.find(
              (p: { type: string; text?: string }) => p.type === "text"
            );
            return textPart?.text ?? "";
          }
        }
      }
    } catch {
      // Not JSON or unexpected format
    }
    return "";
  }

  private findResponse(userMessage: string): ResponseSequence {
    for (const handler of this.handlers) {
      if (handler.once && handler.used) continue;

      const matches =
        typeof handler.pattern === "string"
          ? userMessage.toLowerCase().includes(handler.pattern.toLowerCase())
          : handler.pattern.test(userMessage);

      if (matches) {
        if (handler.once) handler.used = true;
        return handler.responses;
      }
    }

    if (this.fallbackResponse) {
      return this.fallbackResponse;
    }

    // Default: simple acknowledgment
    return this.textMessage("I understand. How can I help?");
  }

  // ── Instance helpers for building response sequences ──

  /**
   * Build a text message response sequence.
   */
  textMessage(
    text: string,
    options: { runId?: string; messageId?: string } = {}
  ): ResponseSequence {
    const runId = options.runId ?? this.nextRunId();
    const messageId = options.messageId ?? this.nextMessageId();
    const threadId = "mock-thread";

    return [
      { type: "RUN_STARTED", runId, threadId },
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text },
      { type: "TEXT_MESSAGE_END", messageId },
      { type: "RUN_FINISHED", runId, threadId },
    ];
  }

  /**
   * Build a tool call followed by a text message response sequence.
   */
  toolCall(
    toolName: string,
    args: Record<string, unknown>,
    options: {
      resultContent?: string;
      followUpText?: string;
      runId?: string;
    } = {}
  ): ResponseSequence {
    const runId = options.runId ?? this.nextRunId();
    const messageId = this.nextMessageId();
    const toolCallId = this.nextToolCallId();
    const threadId = "mock-thread";
    const resultContent = options.resultContent ?? "Tool executed successfully";
    const followUpText =
      options.followUpText ?? `I've executed ${toolName} for you.`;

    return [
      { type: "RUN_STARTED", runId, threadId },
      {
        type: "TOOL_CALL_START",
        toolCallId,
        toolCallName: toolName,
        parentMessageId: messageId,
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId,
        delta: JSON.stringify(args),
      },
      { type: "TOOL_CALL_END", toolCallId },
      {
        type: "TOOL_CALL_RESULT",
        messageId: this.nextMessageId(),
        toolCallId,
        content: resultContent,
        role: "tool",
      },
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: followUpText },
      { type: "TEXT_MESSAGE_END", messageId },
      { type: "RUN_FINISHED", runId, threadId },
    ];
  }

  /**
   * Concatenate multiple response sequences into one.
   */
  static combine(...sequences: ResponseSequence[]): ResponseSequence {
    return sequences.flat();
  }
}
