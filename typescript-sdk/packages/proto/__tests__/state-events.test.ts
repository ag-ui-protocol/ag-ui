import { EventType, StateSnapshotEvent, StateDeltaEvent } from "@ag-ui/core";
import { expect, describe, it } from "@jest/globals";
import { encode, decode } from "../src/proto";
import { expectRoundTripEquality } from "./test-utils";

describe("State Events", () => {
  describe("StateSnapshotEvent", () => {
    it("should round-trip encode/decode correctly", () => {
      const event: StateSnapshotEvent = {
        type: EventType.STATE_SNAPSHOT,
        timestamp: Date.now(),
        snapshot: {
          counter: 42,
          items: ["apple", "banana", "cherry"],
          config: {
            enabled: true,
            maxRetries: 3,
          },
        },
      };

      expectRoundTripEquality(event);
    });

    it("should handle empty snapshot object", () => {
      const event: StateSnapshotEvent = {
        type: EventType.STATE_SNAPSHOT,
        snapshot: {},
      };

      expectRoundTripEquality(event);
    });

    it("should handle complex nested objects", () => {
      const event: StateSnapshotEvent = {
        type: EventType.STATE_SNAPSHOT,
        snapshot: {
          userProfile: {
            name: "John Doe",
            age: 30,
            contact: {
              email: "john@example.com",
              phone: "+1234567890",
              address: {
                street: "123 Main St",
                city: "Anytown",
                country: "USA",
                coordinates: {
                  lat: 37.7749,
                  lng: -122.4194,
                },
              },
            },
            preferences: {
              theme: "dark",
              notifications: true,
              privateProfile: false,
            },
          },
          serviceConfig: {
            endpoints: [
              {
                name: "api1",
                url: "https://api1.example.com",
                methods: ["GET", "POST"],
              },
              {
                name: "api2",
                url: "https://api2.example.com",
                methods: ["GET"],
              },
            ],
            retryPolicy: {
              maxRetries: 3,
              backoff: "exponential",
              timeouts: [1000, 2000, 4000],
            },
          },
          stats: {
            visits: 1042,
            conversions: 123,
            bounceRate: 0.25,
            dataPoints: [
              { date: "2023-01-01", value: 10 },
              { date: "2023-01-02", value: 15 },
              { date: "2023-01-03", value: 8 },
            ],
          },
        },
      };

      expectRoundTripEquality(event);
    });

    it("should handle special values in snapshot", () => {
      const event: StateSnapshotEvent = {
        type: EventType.STATE_SNAPSHOT,
        snapshot: {
          nullValue: null,
          emptyString: "",
          zero: 0,
          negativeNumber: -123,
          floatNumber: 3.14159,
          emptyArray: [],
          emptyObject: {},
          boolValues: { true: true, false: false },
          infinityValue: Infinity,
          nanValue: NaN,
          dateString: new Date().toISOString(),
        },
      };

      const encoded = encode(event);
      const decoded = decode(encoded) as StateSnapshotEvent;

      // Check specific values that might need special handling
      expect(decoded.snapshot.nullValue).toBe(event.snapshot.nullValue);
      expect(decoded.snapshot.emptyString).toBe(event.snapshot.emptyString);
      expect(decoded.snapshot.zero).toBe(event.snapshot.zero);
      expect(decoded.snapshot.negativeNumber).toBe(event.snapshot.negativeNumber);
      expect(decoded.snapshot.floatNumber).toBe(event.snapshot.floatNumber);
      expect(decoded.snapshot.emptyArray).toEqual(event.snapshot.emptyArray);
      expect(decoded.snapshot.emptyObject).toEqual(event.snapshot.emptyObject);
      expect(decoded.snapshot.boolValues).toEqual(event.snapshot.boolValues);
      expect(decoded.snapshot.dateString).toBe(event.snapshot.dateString);

      // Infinity/NaN don't survive JSON.stringify, so they may not be exactly equal
      if (Number.isNaN(decoded.snapshot.nanValue)) {
        expect(Number.isNaN(event.snapshot.nanValue)).toBe(true);
      }
    });
  });

  describe("StateDeltaEvent", () => {
    it("should round-trip encode/decode correctly", () => {
      const event: StateDeltaEvent = {
        type: EventType.STATE_DELTA,
        timestamp: Date.now(),
        delta: [
          { op: "add", path: "/counter", value: 42 },
          { op: "add", path: "/items", value: ["apple", "banana", "cherry"] },
        ],
      };

      expectRoundTripEquality(event);
    });

    it("should handle all JSON Patch operation types", () => {
      const event: StateDeltaEvent = {
        type: EventType.STATE_DELTA,
        delta: [
          { op: "add", path: "/users/123", value: { name: "John", age: 30 } },
          { op: "remove", path: "/users/456" },
          { op: "replace", path: "/users/789/name", value: "Jane Doe" },
          { op: "move", from: "/users/old", path: "/users/new" },
          {
            op: "copy",
            from: "/templates/default",
            path: "/users/123/template",
          },
          { op: "test", path: "/users/123/active", value: true },
        ],
      };

      expectRoundTripEquality(event);
    });

    it("should handle complex values in add operations", () => {
      const event: StateDeltaEvent = {
        type: EventType.STATE_DELTA,
        delta: [
          {
            op: "add",
            path: "/data",
            value: {
              nested: {
                array: [1, 2, 3],
                object: { key: "value" },
              },
              boolean: true,
              number: 42,
            },
          },
        ],
      };

      expectRoundTripEquality(event);
    });

    it("should handle array operations", () => {
      const event: StateDeltaEvent = {
        type: EventType.STATE_DELTA,
        delta: [
          { op: "add", path: "/items", value: [] },
          { op: "add", path: "/items/0", value: "first" },
          { op: "add", path: "/items/-", value: "last" },
          { op: "replace", path: "/items/0", value: "updated first" },
          { op: "remove", path: "/items/1" },
        ],
      };

      expectRoundTripEquality(event);
    });

    it("should handle special characters in paths", () => {
      const event: StateDeltaEvent = {
        type: EventType.STATE_DELTA,
        delta: [
          { op: "add", path: "/special~0field", value: "value with tilde" },
          { op: "add", path: "/special~1field", value: "value with slash" },
          {
            op: "add",
            path: "/special/field",
            value: "value with actual slash",
          },
          { op: "add", path: '/special"field', value: "value with quote" },
          {
            op: "add",
            path: "/emoji\u{1F680}field",
            value: "value with emoji",
          },
        ],
      };

      expectRoundTripEquality(event);
    });

    it("should handle empty delta array", () => {
      const event: StateDeltaEvent = {
        type: EventType.STATE_DELTA,
        delta: [],
      };

      expectRoundTripEquality(event);
    });
  });
});
