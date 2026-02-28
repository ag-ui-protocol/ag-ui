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

        // Find the user's last message in the request body.
        // If there's no user message (e.g. CopilotKit initialization request),
        // pass through to the real backend so the app can boot normally.
        const lastUserMessage = this.extractLastUserMessage(body);
        if (lastUserMessage === null) {
          await route.continue();
          return;
        }
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

  private extractLastUserMessage(body: string): string | null {
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
          return ""; // user message exists but content shape is unrecognized
        }
      }
    } catch {
      // Not JSON or unexpected format
    }
    return null; // no user message found — likely an init request
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

    // Default: simple acknowledgment with stable IDs
    return [
      { type: "RUN_STARTED", runId: "mock-run-default", threadId: "mock-thread" },
      { type: "TEXT_MESSAGE_START", messageId: "mock-msg-default", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "mock-msg-default", delta: "I understand. How can I help?" },
      { type: "TEXT_MESSAGE_END", messageId: "mock-msg-default" },
      { type: "RUN_FINISHED", runId: "mock-run-default", threadId: "mock-thread" },
    ];
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
    const toolParentMessageId = this.nextMessageId();
    const toolCallId = this.nextToolCallId();
    const toolResultMessageId = this.nextMessageId();
    const followUpMessageId = this.nextMessageId();
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
        parentMessageId: toolParentMessageId,
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId,
        delta: JSON.stringify(args),
      },
      { type: "TOOL_CALL_END", toolCallId },
      {
        type: "TOOL_CALL_RESULT",
        messageId: toolResultMessageId,
        toolCallId,
        content: resultContent,
        role: "tool",
      },
      { type: "TEXT_MESSAGE_START", messageId: followUpMessageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: followUpMessageId, delta: followUpText },
      { type: "TEXT_MESSAGE_END", messageId: followUpMessageId },
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
