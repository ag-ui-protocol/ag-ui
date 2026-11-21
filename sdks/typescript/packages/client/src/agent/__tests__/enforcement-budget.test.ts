import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lastValueFrom, Observable, of } from "rxjs";
import { toArray } from "rxjs/operators";
import { AGUIError, BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { AbstractAgent } from "../agent";
import { HttpAgent } from "../http";
import { AgentConfig } from "../types";
import { AGUIEnforcementLimitError, DEFAULT_MAX_ENFORCED_ENTRIES } from "@/enforce";

const userMessages = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: "user" as const,
    content: "hi",
  }));

// 2 keys on the event + 3 messages = 5, so a budget of 4 trips at /messages.
const eventsWithSnapshot = (input: RunAgentInput): BaseEvent[] => [
  { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent,
  { type: EventType.MESSAGES_SNAPSHOT, messages: userMessages(3) } as BaseEvent,
  { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as BaseEvent,
];

class BudgetAgent extends AbstractAgent {
  constructor(config: AgentConfig = {}) {
    super(config);
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return of(...eventsWithSnapshot(input));
  }
  override connect(input: RunAgentInput): Observable<BaseEvent> {
    return of(...eventsWithSnapshot(input));
  }
}

const limitError = { name: "AGUIEnforcementLimitError", path: "/messages", limit: 4 };

describe("AbstractAgent.maxEnforcedEntries", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // The agent logs the failure it is about to throw; that is the expected outcome here.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("defaults to DEFAULT_MAX_ENFORCED_ENTRIES", () => {
    expect(new BudgetAgent().maxEnforcedEntries).toBe(DEFAULT_MAX_ENFORCED_ENTRIES);
  });

  it("fails runAgent when an event exceeds it", async () => {
    await expect(new BudgetAgent({ maxEnforcedEntries: 4 }).runAgent()).rejects.toMatchObject(
      limitError,
    );
  });

  it("applies to connectAgent", async () => {
    await expect(new BudgetAgent({ maxEnforcedEntries: 4 }).connectAgent()).rejects.toMatchObject(
      limitError,
    );
  });

  it("applies to the legacy bridge", async () => {
    const legacy$ = new BudgetAgent({
      maxEnforcedEntries: 4,
    }).legacy_to_be_removed_runAgentBridged();
    await expect(lastValueFrom(legacy$.pipe(toArray()))).rejects.toMatchObject(limitError);
  });

  it("applies a value assigned after construction", async () => {
    const agent = new BudgetAgent();
    agent.maxEnforcedEntries = 4;
    await expect(agent.runAgent()).rejects.toMatchObject(limitError);
  });

  it("rejects invalid values at construction and on assignment", () => {
    for (const bad of [0, -1, 1.5, NaN, "10"]) {
      expect(() => new BudgetAgent({ maxEnforcedEntries: bad as unknown as number })).toThrow(
        AGUIError,
      );
    }
    const agent = new BudgetAgent();
    expect(() => {
      agent.maxEnforcedEntries = NaN;
    }).toThrow(AGUIError);
  });

  it("survives clone, whether set by config or afterwards", () => {
    expect(new BudgetAgent({ maxEnforcedEntries: 7 }).clone().maxEnforcedEntries).toBe(7);
    const agent = new BudgetAgent();
    agent.maxEnforcedEntries = 9;
    expect(agent.clone().maxEnforcedEntries).toBe(9);
  });

  it("HttpAgent refuses an oversized outgoing input before fetching", async () => {
    const fetch = vi.fn();
    const agent = new HttpAgent({
      url: "https://example.invalid/agent",
      fetch,
      initialMessages: userMessages(50),
      maxEnforcedEntries: 40,
    });
    await expect(agent.runAgent()).rejects.toBeInstanceOf(AGUIEnforcementLimitError);
    await expect(agent.runAgent()).rejects.toMatchObject({ path: "/messages" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
