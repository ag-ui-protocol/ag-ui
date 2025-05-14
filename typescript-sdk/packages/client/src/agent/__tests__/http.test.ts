import { HttpAgent } from "../http";
import { runHttpRequest, HttpEvent, HttpEventType } from "@/run/http-request";
import { v4 as uuidv4 } from "uuid";
import { Observable, of } from "rxjs";

// Mock the runHttpRequest module
jest.mock("@/run/http-request", () => ({
  runHttpRequest: jest.fn(),
  HttpEventType: {
    HEADERS: "headers",
    DATA: "data",
  },
}));

// Mock uuid module
jest.mock("uuid", () => ({
  v4: jest.fn().mockReturnValue("mock-run-id"),
}));

// Mock transformHttpEventStream
jest.mock("@/transform/http", () => ({
  transformHttpEventStream: jest.fn((source$) => source$),
}));

describe("HttpAgent", () => {
  // Reset mocks before each test
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should configure and execute HTTP requests correctly", async () => {
    // Setup mock observable for the HTTP response
    const mockObservable = of({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: new Headers(),
    });

    // Mock the runHttpRequest function
    (runHttpRequest as jest.Mock).mockReturnValue(mockObservable);

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
    (runHttpRequest as jest.Mock).mockReturnValue(of());

    // Configure test agent
    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    // Spy on the abort method of AbortController
    const abortSpy = jest.spyOn(AbortController.prototype, "abort");

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
    (runHttpRequest as jest.Mock).mockReturnValue(of());

    // Configure test agent
    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    // Create a custom abort controller
    const customController = new AbortController();
    const abortSpy = jest.spyOn(customController, "abort");

    // Set the custom controller
    agent.abortController = customController;

    // Call abortRun directly
    agent.abortRun();

    // Verify the custom controller was used
    expect(abortSpy).toHaveBeenCalled();

    // Clean up
    abortSpy.mockRestore();
  });

  it("should handle transformHttpEventStream correctly", () => {
    // Import the actual transformHttpEventStream function
    const { transformHttpEventStream } = require("../../transform/http");

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

    (runHttpRequest as jest.Mock).mockReturnValue(mockObservable);

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

    // Verify that transformHttpEventStream was called with the mock observable
    expect(transformHttpEventStream).toHaveBeenCalledWith(mockObservable);
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
    (runHttpRequest as jest.Mock).mockReturnValue(mockResponseObservable);

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
