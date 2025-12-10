import { BaseEvent } from "@ag-ui/core";
import { encode, decode } from "../src/proto";
import { expect, describe, it } from "@jest/globals";

/**
 * Performs a round-trip encode-decode on an event and returns the decoded result
 */
export function roundTrip<T extends BaseEvent>(event: T): T {
  const encoded = encode(event);
  return decode(encoded) as T;
}

/**
 * Verifies that an event is the same after round-trip encoding and decoding
 */
export function expectRoundTripEquality<T extends BaseEvent>(event: T): void {
  const decoded = roundTrip(event);

  // Verify all properties match
  for (const key in event) {
    if (Object.prototype.hasOwnProperty.call(event, key)) {
      expect(decoded[key]).toEqual(event[key]);
    }
  }
}

// Add a simple test to prevent "Your test suite must contain at least one test" error
describe("Test Utilities", () => {
  it("should exist as a module for other tests to import from", () => {
    expect(typeof roundTrip).toBe("function");
    expect(typeof expectRoundTripEquality).toBe("function");
  });
});
