import { runHttpRequest, HttpEventType } from "../http-request";

describe("runHttpRequest", () => {
  let originalFetch: any;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    // Save original fetch
    originalFetch = global.fetch;

    // Create a mock fetch function with proper response structure
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
  });

  it("should call fetch with the provided configuration", async () => {
    // Set up test configuration
    const config = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ key: "value" }),
    };

    // Mock a proper response
    const mockHeaders = new Headers();
    mockHeaders.append("Content-Type", "application/json");

    const mockResponse = {
      status: 200,
      headers: mockHeaders,
      body: {
        getReader: jest.fn().mockReturnValue({
          read: jest.fn().mockResolvedValue({ done: true }),
          cancel: jest.fn(),
        }),
      },
    };

    fetchMock.mockResolvedValue(mockResponse);

    // Create the run agent function

    // Execute the function which should trigger a fetch call
    const observable = runHttpRequest("https://example.com/api", config);

    // Subscribe to trigger the fetch
    const subscription = observable.subscribe({
      next: () => {},
      error: () => {},
      complete: () => {},
    });

    // Give time for async operations to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify fetch was called with the expected parameters
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/api", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ key: "value" }),
    });

    // Clean up subscription
    subscription.unsubscribe();
  });

  it("should pass an abort signal when provided", async () => {
    // Create an abort controller
    const abortController = new AbortController();

    // Set up test configuration with abort signal
    const config = {
      method: "GET",
      abortSignal: abortController.signal,
    };

    // Mock a proper response
    const mockHeaders = new Headers();
    mockHeaders.append("Content-Type", "application/json");

    const mockResponse = {
      status: 200,
      headers: mockHeaders,
      body: {
        getReader: jest.fn().mockReturnValue({
          read: jest.fn().mockResolvedValue({ done: true }),
          cancel: jest.fn(),
        }),
      },
    };

    fetchMock.mockResolvedValue(mockResponse);

    // Create the run agent function
    const observable = runHttpRequest("https://example.com/api", config);

    // Subscribe to trigger the fetch
    const subscription = observable.subscribe();

    // Give time for async operations to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify fetch was called with the expected configuration
    // The implementation passes the config directly, including abortSignal property
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/api", {
      method: "GET",
      abortSignal: abortController.signal,
    });

    // Clean up subscription
    subscription.unsubscribe();
  });

  it("should emit headers and data events from the response", async () => {
    // Create mock chunks to be returned by the reader
    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5, 6]);

    // Mock reader that returns multiple chunks before completing
    const mockReader = {
      read: jest
        .fn()
        .mockResolvedValueOnce({ done: false, value: chunk1 })
        .mockResolvedValueOnce({ done: false, value: chunk2 })
        .mockResolvedValueOnce({ done: true }),
      cancel: jest.fn(),
    };

    // Mock response with our custom reader and headers
    const mockHeaders = new Headers();
    mockHeaders.append("Content-Type", "application/json");

    const mockResponse = {
      status: 200,
      headers: mockHeaders,
      body: {
        getReader: jest.fn().mockReturnValue(mockReader),
      },
    };

    // Override the fetch mock for this specific test
    fetchMock.mockResolvedValue(mockResponse);

    // Set up test configuration
    const config = {
      method: "GET",
    };

    // Create and execute the run agent function
    const observable = runHttpRequest("https://example.com/api", config);

    // Collect the emitted events
    const emittedEvents: any[] = [];
    const subscription = observable.subscribe({
      next: (event) => emittedEvents.push(event),
      error: (err) => fail(`Should not have errored: ${err}`),
      complete: () => {},
    });

    // Wait for all async operations to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify we received the expected events
    expect(emittedEvents.length).toBe(3);

    // First event should be headers
    expect(emittedEvents[0].type).toBe(HttpEventType.HEADERS);
    expect(emittedEvents[0].status).toBe(200);
    expect(emittedEvents[0].headers).toBe(mockHeaders);

    // Second and third events should be data
    expect(emittedEvents[1].type).toBe(HttpEventType.DATA);
    expect(emittedEvents[1].data).toBe(chunk1);

    expect(emittedEvents[2].type).toBe(HttpEventType.DATA);
    expect(emittedEvents[2].data).toBe(chunk2);

    // Verify reader.read was called the expected number of times
    expect(mockReader.read).toHaveBeenCalledTimes(3);

    // Clean up
    subscription.unsubscribe();
  });
});
