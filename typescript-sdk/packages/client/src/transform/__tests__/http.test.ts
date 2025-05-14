import { transformHttpEventStream } from "../http";
import { HttpEvent, HttpEventType } from "../../run/http-request";
import { parseProtoStream } from "../proto";
import * as proto from "@ag-ui/proto";
import { BaseEvent, EventType } from "@ag-ui/core";
import { Subject, of, throwError } from "rxjs";

// Mock dependencies
jest.mock("../proto", () => ({
  parseProtoStream: jest.fn(),
}));

describe("transformHttpEventStream", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("should correctly transform protocol buffer events", () => {
    // Given
    const mockHttpSource = new Subject<HttpEvent>();
    const mockBaseEvent: BaseEvent = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      timestamp: Date.now(),
    };

    // Mock parseProtoStream to return our test event
    (parseProtoStream as jest.Mock).mockReturnValue(of(mockBaseEvent));

    // Create a list to collect emitted events
    const receivedEvents: BaseEvent[] = [];

    // When
    const result$ = transformHttpEventStream(mockHttpSource);
    result$.subscribe((event) => receivedEvents.push(event));

    // Send a HEADERS event with protocol buffer content type
    mockHttpSource.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: new Headers([["content-type", proto.AGUI_MEDIA_TYPE]]),
    });

    // Send a DATA event
    mockHttpSource.next({
      type: HttpEventType.DATA,
      data: new Uint8Array([1, 2, 3, 4]),
    });

    // Complete the stream
    mockHttpSource.complete();

    // Then
    expect(parseProtoStream).toHaveBeenCalled();
    expect(receivedEvents).toEqual([mockBaseEvent]);
  });

  test("should handle parseProtoStream errors", (done) => {
    // Given
    const mockHttpSource = new Subject<HttpEvent>();
    const testError = new Error("Test proto parsing error");

    // Mock parseProtoStream to throw an error
    (parseProtoStream as jest.Mock).mockReturnValue(throwError(() => testError));

    // When
    const result$ = transformHttpEventStream(mockHttpSource);
    result$.subscribe({
      next: () => {
        // Should not emit any events
        fail("Should not emit events when parseProtoStream errors");
      },
      error: (err) => {
        // Then
        expect(err).toBe(testError);
        done();
      },
    });

    // Send a HEADERS event with protocol buffer content type
    mockHttpSource.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: new Headers([["content-type", proto.AGUI_MEDIA_TYPE]]),
    });
  });

  test("should error if DATA received before HEADERS", (done) => {
    // Given
    const mockHttpSource = new Subject<HttpEvent>();

    // When
    const result$ = transformHttpEventStream(mockHttpSource);
    result$.subscribe({
      next: () => {
        // Should not emit any events
        fail("Should not emit events when DATA received before HEADERS");
      },
      error: (err) => {
        // Then
        expect(err.message).toContain("No headers event received before data events");
        done();
      },
    });

    // Send a DATA event before HEADERS
    mockHttpSource.next({
      type: HttpEventType.DATA,
      data: new Uint8Array([1, 2, 3, 4]),
    });
  });
});
