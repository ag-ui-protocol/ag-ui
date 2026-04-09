import { HttpAgent } from "../http";
import { runHttpRequest, HttpEvent, HttpEventType } from "@/run/http-request";
import { v4 as uuidv4 } from "uuid";
import { Observable, of } from "rxjs";
import { describe, it, expect, vi, beforeEach, Mock, afterEach } from "vitest";
import { AgentCapabilities } from "@ag-ui/core";

// Mock the runHttpRequest module
vi.mock("@/run/http-request", () => ({
  runHttpRequest: vi.fn(),
  HttpEventType: {
    HEADERS: "headers",
    DATA: "data",
  },
}));

// Mock uuid module
vi.mock("uuid", () => ({
  v4: vi.fn().mockReturnValue("mock-run-id"),
}));

// Mock transformHttpEventStream
vi.mock("@/transform/http", () => ({
  transformHttpEventStream: vi.fn((source$) => source$),
}));

describe("HttpAgent", () => {
  // Reset mocks before each test
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should configure and execute HTTP requests correctly", async () => {
    // Setup mock observable for the HTTP response
    const mockObservable = of({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: new Headers(),
    });

    // Mock the runHttpRequest function
    (runHttpRequest as Mock).mockReturnValue(mockObservable);

    // Configure test agent
    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
    });

    // Setup input data for the agent
    agent.messages = [
      {
        id: uuidv4(),
        role: "user",
        content: "Hello",
      },
    ];

    // Prepare the input that would be used in runAgent
    const input = {
      threadId: agent.threadId,
      runId: "mock-run-id",
      tools: [],
      context: [],
      forwardedProps: {},
      state: agent.state,
      messages: agent.messages,
    };

    // Call run method directly, which should call runHttpRequest
    agent.run(input);

    // Verify runHttpRequest was called with correct config
    expect(runHttpRequest).toHaveBeenCalledWith("https://api.example.com/v1/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(input),
      signal: expect.any(AbortSignal),
    });
  });

  it("should abort the request when abortRun is called", () => {
    // Setup mock implementation
    (runHttpRequest as Mock).mockReturnValue(of());

    // Configure test agent
    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    // Spy on the abort method of AbortController
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");

    // Trigger runAgent without actually calling it by checking the abortController
    expect(agent.abortController).toBeInstanceOf(AbortController);

    // Call abortRun directly
    agent.abortRun();

    // Verify abort was called
    expect(abortSpy).toHaveBeenCalled();

    // Clean up
    abortSpy.mockRestore();
  });

  it("should use a custom abort controller when provided", () => {
    // Setup mock implementation
    (runHttpRequest as Mock).mockReturnValue(of());

    // Configure test agent
    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    // Create a custom abort controller
    const customController = new AbortController();
    const abortSpy = vi.spyOn(customController, "abort");

    // Set the custom controller
    agent.abortController = customController;

    // Call abortRun directly
    agent.abortRun();

    // Verify the custom controller was used
    expect(abortSpy).toHaveBeenCalled();

    // Clean up
    abortSpy.mockRestore();
  });

  it("should handle transformHttpEventStream correctly", async () => {
    // Import the actual transformHttpEventStream function
    const { transformHttpEventStream } = await import("../../transform/http");

    // Verify transformHttpEventStream is a function
    expect(typeof transformHttpEventStream).toBe("function");

    // Configure test agent
    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    // Verify that the HttpAgent's run method uses transformHttpEventStream
    // This is an indirect test of implementation details, but useful to verify the pipeline
    const mockObservable = of({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: new Headers(),
    });

    (runHttpRequest as Mock).mockReturnValue(mockObservable);

    // Call run with mock input
    const input = {
      threadId: agent.threadId,
      runId: "test-run-id",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    };

    // Execute the run function
    agent.run(input);

    // Verify that transformHttpEventStream was called with the mock observable and debugLogger
    // When debug is off (default), createDebugLogger returns undefined
    expect(transformHttpEventStream).toHaveBeenCalledWith(mockObservable, undefined);
  });

  it("should process HTTP response data end-to-end", async () => {
    // Create mock headers
    const mockHeaders = new Headers();
    mockHeaders.append("Content-Type", "text/event-stream");

    // Create a mock response data
    const mockResponseObservable = of(
      {
        type: HttpEventType.HEADERS,
        status: 200,
        headers: mockHeaders,
      },
      {
        type: HttpEventType.DATA,
        data: new Uint8Array(
          new TextEncoder().encode(
            'data: {"type": "TEXT_MESSAGE_START", "messageId": "test-id"}\n\n',
          ),
        ),
      },
    );

    // Directly mock runHttpRequest
    (runHttpRequest as Mock).mockReturnValue(mockResponseObservable);

    // Configure test agent
    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    // Prepare input for the agent
    const input = {
      threadId: agent.threadId,
      runId: "mock-run-id",
      tools: [],
      context: [],
      forwardedProps: {},
      state: agent.state,
      messages: agent.messages,
    };

    // Call run method directly
    agent.run(input);

    // Verify runHttpRequest was called with correct config
    expect(runHttpRequest).toHaveBeenCalledWith("https://api.example.com/v1/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(input),
      signal: expect.any(AbortSignal),
    });
  });
});

describe("HttpAgent.getCapabilities", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("should fetch capabilities from {url}/capabilities", async () => {
    const mockCapabilities: AgentCapabilities = {
      identity: { name: "TestAgent", type: "test" },
      custom: { predictiveChips: true },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockCapabilities),
    });

    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: { Authorization: "Bearer test-token" },
    });

    const result = await agent.getCapabilities();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/capabilities",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          Accept: "application/json",
        }),
      }),
    );
    expect(result).toEqual(mockCapabilities);
  });

  it("should use caller-provided AbortSignal", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    const controller = new AbortController();
    await agent.getCapabilities(controller.signal);

    const fetchCall = (globalThis.fetch as Mock).mock.calls[0];
    expect(fetchCall[1].signal).toBe(controller.signal);
  });

  it("should not use the run AbortController signal", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    await agent.getCapabilities();

    const fetchCall = (globalThis.fetch as Mock).mock.calls[0];
    expect(fetchCall[1].signal).toBeUndefined();
  });

  it("should strip trailing slashes from url before appending /capabilities", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const agent = new HttpAgent({
      url: "https://api.example.com/agent/",
      headers: {},
    });

    await agent.getCapabilities();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.example.com/agent/capabilities",
      expect.any(Object),
    );
  });

  it("should throw on HTTP error responses", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not Found"),
    });

    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    await expect(agent.getCapabilities()).rejects.toThrow(
      "Failed to fetch capabilities from https://api.example.com/v1/chat/capabilities: HTTP 404: Not Found",
    );
  });

  it("should throw on server error responses", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    await expect(agent.getCapabilities()).rejects.toThrow("HTTP 500");
  });

  it("should forward custom headers in the request", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {
        "X-Custom-Header": "custom-value",
        Authorization: "Bearer my-token",
      },
    });

    await agent.getCapabilities();

    const fetchCall = (globalThis.fetch as Mock).mock.calls[0];
    expect(fetchCall[1].headers).toMatchObject({
      "X-Custom-Header": "custom-value",
      Authorization: "Bearer my-token",
      Accept: "application/json",
    });
  });

  it("should parse and validate capabilities with Zod schema", async () => {
    const fullCapabilities: AgentCapabilities = {
      identity: { name: "MyAgent", type: "adk", version: "1.0.0" },
      transport: { streaming: true, websocket: false },
      tools: { supported: true, parallelCalls: false },
      state: { snapshots: true, deltas: true },
      custom: {
        predictiveChips: { enabled: true, maxCount: 3 },
        suggestedQuestions: { enabled: true },
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(fullCapabilities),
    });

    const agent = new HttpAgent({
      url: "https://api.example.com/agent",
      headers: {},
    });

    const result = await agent.getCapabilities();

    expect(result.identity?.name).toBe("MyAgent");
    expect(result.transport?.streaming).toBe(true);
    expect(result.custom?.predictiveChips).toEqual({ enabled: true, maxCount: 3 });
  });
});
