/**
 * RunAgentInput.context[] and .forwardedProps are exposed on hook contexts
 * as a ToolCallContextExtras convenience. The AG-UI `Context` schema is
 * `{ description: string; value: string }` — entries are keyed by
 * `description`.
 */

import { describe, it, expect } from "vitest";
import type { RunAgentInput } from "@ag-ui/core";
import { buildContextExtras } from "../config";
import { minimalRunInput } from "./helpers";

const input = (overrides: Partial<RunAgentInput>): RunAgentInput =>
  minimalRunInput({ threadId: "t", runId: "r", ...overrides });

describe("buildContextExtras", () => {
  it("flattens context[] keyed by description", () => {
    const r = buildContextExtras(
      input({
        context: [
          {
            description: "locale",
            value: "en-US",
          } as unknown as RunAgentInput["context"][number],
          {
            description: "userId",
            value: "u-42",
          } as unknown as RunAgentInput["context"][number],
        ],
      }),
    );
    expect(r.context.locale).toBe("en-US");
    expect(r.context.userId).toBe("u-42");
  });

  it("ignores entries without a valid description", () => {
    const r = buildContextExtras(
      input({
        context: [
          { value: "no-desc" } as unknown as RunAgentInput["context"][number],
          {
            description: "",
            value: "empty",
          } as unknown as RunAgentInput["context"][number],
          {
            description: null,
            value: "null",
          } as unknown as RunAgentInput["context"][number],
          "a string" as unknown as RunAgentInput["context"][number],
          null as unknown as RunAgentInput["context"][number],
        ],
      }),
    );
    expect(Object.keys(r.context)).toEqual([]);
  });

  it("blocks prototype-pollution keys", () => {
    const r = buildContextExtras(
      input({
        context: [
          {
            description: "__proto__",
            value: "nope",
          } as unknown as RunAgentInput["context"][number],
          {
            description: "constructor",
            value: "nope",
          } as unknown as RunAgentInput["context"][number],
          {
            description: "prototype",
            value: "nope",
          } as unknown as RunAgentInput["context"][number],
          {
            description: "ok",
            value: "yes",
          } as unknown as RunAgentInput["context"][number],
        ],
      }),
    );
    expect(Object.keys(r.context)).toEqual(["ok"]);
    // And the returned object has no prototype at all — sanity-check.
    expect(Object.getPrototypeOf(r.context)).toBeNull();
  });

  it("uses forwardedProps verbatim when it's an object", () => {
    const r = buildContextExtras(
      input({ forwardedProps: { auth: "Bearer ...", tenantId: "t-1" } }),
    );
    expect(r.forwardedProps).toEqual({ auth: "Bearer ...", tenantId: "t-1" });
  });

  it("empty defaults when fields are missing or wrong-typed", () => {
    const empty = buildContextExtras(input({}));
    expect(Object.keys(empty.context)).toEqual([]);
    expect(empty.forwardedProps).toEqual({});
    expect(
      buildContextExtras(
        input({
          forwardedProps: ["not", "an", "object"] as unknown as Record<
            string,
            unknown
          >,
        }),
      ).forwardedProps,
    ).toEqual({});
  });

  it("later duplicate keys overwrite earlier ones", () => {
    const r = buildContextExtras(
      input({
        context: [
          {
            description: "locale",
            value: "en",
          } as unknown as RunAgentInput["context"][number],
          {
            description: "locale",
            value: "en-GB",
          } as unknown as RunAgentInput["context"][number],
        ],
      }),
    );
    expect(r.context.locale).toBe("en-GB");
  });

  it("coerces non-string values to string", () => {
    const r = buildContextExtras(
      input({
        context: [
          {
            description: "n",
            value: 42 as unknown as string,
          } as unknown as RunAgentInput["context"][number],
        ],
      }),
    );
    expect(r.context.n).toBe("42");
  });
});
