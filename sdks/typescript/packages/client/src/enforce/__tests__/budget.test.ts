import { describe, it, expect } from "vitest";
import { lastValueFrom, of } from "rxjs";
import { toArray } from "rxjs/operators";
import { z } from "zod/v4";
import { AGUIError, BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { enforceEvents, enforceOutgoingInput } from "../enforce";
import { AGUIEnforcementLimitError, DEFAULT_MAX_ENFORCED_ENTRIES } from "../limits";
import { stripUnknown } from "../strip";
import * as publicApi from "@/index";

const items = z.looseObject({ items: z.array(z.number()) });

const userMessages = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `m${i}`, role: "user", content: "hi" }));

const snapshot = (messages: unknown[]) =>
  ({ type: EventType.MESSAGES_SNAPSHOT, messages }) as unknown as BaseEvent;

const input = (messageCount: number) =>
  ({
    threadId: "t1",
    runId: "r1",
    state: {},
    messages: userMessages(messageCount),
    tools: [],
    context: [],
    forwardedProps: {},
  }) as unknown as RunAgentInput;

const enforced = (events: BaseEvent[], maxEntries?: number) =>
  lastValueFrom(
    enforceEvents(
      undefined,
      maxEntries === undefined ? undefined : { maxEntries },
    )(of(...events)).pipe(toArray()),
  );

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
};

describe("stripUnknown entry budget", () => {
  it("allows a payload exactly at the budget", () => {
    // 1 key on the object + 3 elements = 4 entries.
    const { value } = stripUnknown({ items: [1, 2, 3] }, items, { maxEntries: 4 });
    expect(value).toEqual({ items: [1, 2, 3] });
  });

  it("rejects one entry over the budget, naming the container and the limit", () => {
    const error = caught(() => stripUnknown({ items: [1, 2, 3] }, items, { maxEntries: 3 }));
    expect(error).toBeInstanceOf(AGUIEnforcementLimitError);
    expect(error).toBeInstanceOf(AGUIError);
    expect(error).toMatchObject({ limit: 3, path: "/items", name: "AGUIEnforcementLimitError" });
    expect((error as Error).message).toContain("at '/items'");
    expect((error as Error).message).toContain("more than 3 entries");
  });

  it("rejects an oversized array before reading any element", () => {
    let reads = 0;
    const proxied = new Proxy(
      Array.from({ length: 10 }, (_, i) => i),
      {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) reads++;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(() => stripUnknown({ items: proxied }, items, { maxEntries: 5 })).toThrow(
      AGUIEnforcementLimitError,
    );
    expect(reads).toBe(0);
  });

  it("counts unknown keys, reporting a root overflow as (root)", () => {
    const flood = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    const error = caught(() =>
      stripUnknown(flood, z.looseObject({ id: z.string() }), { maxEntries: 5 }),
    );
    expect(error).toMatchObject({ path: "" });
    expect((error as Error).message).toContain("at '(root)'");
  });

  it("counts record entries", () => {
    const schema = z.looseObject({ payload: z.record(z.string(), z.number()) });
    const error = caught(() =>
      stripUnknown({ payload: { a: 1, b: 2, c: 3, d: 4, e: 5 } }, schema, { maxEntries: 3 }),
    );
    expect(error).toMatchObject({ path: "/payload" });
  });

  it("does not walk opaque positions", () => {
    const schema = z.looseObject({ state: z.any() });
    expect(() =>
      stripUnknown({ state: { big: new Array(10_000).fill(0) } }, schema, { maxEntries: 5 }),
    ).not.toThrow();
  });

  it("rejects budgets that would silently disable or always trip it", () => {
    for (const bad of [0, -1, 1.5, NaN, "10"]) {
      expect(() =>
        stripUnknown({ items: [] }, items, { maxEntries: bad as unknown as number }),
      ).toThrow(AGUIError);
    }
  });
});

describe("enforceEvents / enforceOutgoingInput entry budget", () => {
  it("fails the stream when an event exceeds the budget", async () => {
    // 2 keys on the event + 3 messages = 5 > 4, charged at the array.
    await expect(enforced([snapshot(userMessages(3))], 4)).rejects.toMatchObject({
      name: "AGUIEnforcementLimitError",
      path: "/messages",
    });
  });

  it("spends the budget per event, not across the stream", async () => {
    const events = Array.from(
      { length: 50 },
      () => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "x" }) as BaseEvent,
    );
    await expect(enforced(events, 10)).resolves.toHaveLength(50);
  });

  it("applies DEFAULT_MAX_ENFORCED_ENTRIES when no budget is given", async () => {
    // Holes: the length alone trips it, so nothing is allocated per element.
    const huge = snapshot(new Array(DEFAULT_MAX_ENFORCED_ENTRIES + 1));
    await expect(enforced([huge])).rejects.toMatchObject({
      limit: 1_000_000,
      path: "/messages",
    });
  });

  it("Infinity disables the budget", async () => {
    // Over the default, so a budget that ignored Infinity would fail here.
    const huge = snapshot(new Array(DEFAULT_MAX_ENFORCED_ENTRIES + 1));
    await expect(enforced([huge], Infinity)).resolves.toHaveLength(1);
  });

  it("rejects an invalid budget where it is passed", () => {
    expect(() => enforceEvents(undefined, { maxEntries: NaN })).toThrow(AGUIError);
    expect(() => enforceOutgoingInput(input(0), { maxEntries: 0 })).toThrow(AGUIError);
  });

  it("checks the outgoing input against the budget", () => {
    // 7 top-level keys + 5 messages = 12 > 11, charged at the array.
    expect(caught(() => enforceOutgoingInput(input(5), { maxEntries: 11 }))).toMatchObject({
      path: "/messages",
    });
    expect(() => enforceOutgoingInput(input(0), { maxEntries: 11 })).not.toThrow();
  });

  it("is on the public API", () => {
    expect(publicApi.AGUIEnforcementLimitError).toBe(AGUIEnforcementLimitError);
    expect(publicApi.DEFAULT_MAX_ENFORCED_ENTRIES).toBe(1_000_000);
  });
});
