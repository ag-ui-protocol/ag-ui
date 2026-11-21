import Anthropic from "@anthropic-ai/sdk";
import { lastValueFrom, toArray } from "rxjs";
import { expect, it } from "vitest";
import { recoverSession } from "../recovery";
import { STATE_TOOL, stateCommit, stateText } from "../state";
import { attachContext } from "../context";
import type { SessionRecord } from "../types";
import { createFakeClient } from "./fake-client";
import { ManagedAgentsAgent } from "../agent";
import { InMemorySessionStore } from "../sessions";

const at = (n: number) => new Date(1700000000000 + n).toISOString();
const message = (id: string, time: number) => ({
  id,
  type: "agent.message",
  processed_at: at(time),
  content: [{ type: "text", text: id }],
});

it.each([100, 1000])(
  "pages from the native checkpoint across restarts with %i older events",
  async (count) => {
    const history: {
      id: string;
      type: string;
      processed_at: string;
      [key: string]: unknown;
    }[] = Array.from({ length: count }, (_, i) => message("old-" + i, i));
    history.push(
      {
        id: "tool",
        type: "agent.custom_tool_use",
        name: "external",
        input: {},
        processed_at: at(count),
      },
      {
        id: "approval",
        type: "agent.tool_use",
        name: "read",
        evaluated_permission: "ask",
        processed_at: at(count),
      },
      {
        id: "park",
        type: "session.status_idle",
        stop_reason: {
          type: "requires_action",
          event_ids: ["tool", "approval"],
        },
        processed_at: at(count + 1),
      },
    );
    const reads: { from: string | null; page: string | null; rows: number }[] =
      [];
    const requests: string[] = [];
    let live = "";
    const client = new Anthropic({
      apiKey: "local",
      baseURL: "https://fixture.invalid",
      maxRetries: 0,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/events/stream")) {
          requests.push("stream");
          return new Response(live, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        if (url.pathname.endsWith("/events") && init?.method === "GET") {
          requests.push("list");
          const from = url.searchParams.get("created_at[gte]");
          const page = url.searchParams.get("page");
          const offset = page ? Number(page.slice(5)) : 0;
          const visible = history.filter(
            (event) => !from || event.processed_at >= from,
          );
          const data = visible.slice(offset, offset + 3);
          const more = offset + 3 < visible.length;
          reads.push({ from, page, rows: data.length });
          return Response.json({
            data,
            has_more: more,
            next_page: more ? "page-" + (offset + 3) : null,
          });
        }
        if (url.pathname.endsWith("/events")) {
          requests.push("send");
          return Response.json({ data: [] });
        }
        return Response.json({ id: "s", status: "idle", agent: { tools: [] } });
      },
    });
    const store = new InMemorySessionStore();
    const run = (send = false) =>
      lastValueFrom(
        new ManagedAgentsAgent({
          managedAgentId: "a",
          environmentId: "e",
          client,
          sessionStore: store,
          resolveSession: () => ({ sessionId: "s" }),
        })
          .run({
            threadId: "t",
            runId: "r",
            tools: [],
            context: [],
            forwardedProps: {},
            messages: send
              ? [{ id: "followup", role: "user" as const, content: "continue" }]
              : [],
          })
          .pipe(toArray()),
      );
    expect((await run()).at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      outcome: { type: "interrupt" },
    });
    reads.length = requests.length = 0;
    history.push(
      {
        id: "result",
        type: "user.custom_tool_result",
        custom_tool_use_id: "tool",
        content: [],
        processed_at: at(count + 1),
      },
      {
        id: "allowed",
        type: "user.tool_confirmation",
        tool_use_id: "approval",
        result: "allow",
        processed_at: at(count + 2),
      },
      message("offline", count + 3),
    );
    const idle = {
      id: "end",
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
      processed_at: at(count + 4),
    };
    live = [history.at(-1)!, idle]
      .map((e) => "event: " + e.type + "\ndata: " + JSON.stringify(e) + "\n\n")
      .join("");
    const events = await run(true);
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
    expect(events.at(-1)).not.toHaveProperty("outcome");
    expect(
      events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT"),
    ).toHaveLength(1);
    expect(events.filter((e) => e.type === "TOOL_CALL_RESULT")).toHaveLength(1);
    expect(requests).toEqual(["stream", "list", "list", "send"]);
    expect(reads).toEqual([
      { from: at(count + 1), page: null, rows: 3 },
      { from: at(count + 1), page: "page-3", rows: 1 },
    ]);
  },
);

type Row = {
  id: string;
  type: string;
  processed_at?: string | null;
  [key: string]: unknown;
};

function nativeHistory(rows: Row[]) {
  const fake = createFakeClient();
  const record: SessionRecord = {
    sessionId: "s",
    pendingClientToolUseIds: [],
    toolNames: [],
  };
  const queries: (string | undefined)[] = [];
  let failure: number | undefined;
  fake.spies.list.mockImplementation((_id, params) => ({
    async *[Symbol.asyncIterator]() {
      const from = (params as { "created_at[gte]"?: string })[
        "created_at[gte]"
      ];
      queries.push(from);
      for (const row of rows) {
        if (from && (!row.processed_at || row.processed_at < from)) continue;
        yield row;
        if (from && failure)
          throw Object.assign(new Error("list failed"), { status: failure });
      }
    },
  }));
  return {
    record,
    queries,
    fail: (status?: number) => {
      failure = status;
    },
    async recover(saved = record) {
      const replay: string[] = [];
      const result = await recoverSession(
        fake.client,
        saved,
        AbortSignal.timeout(2000),
        (event) => {
          if (event.type === "RAW" && "event" in event)
            replay.push((event.event as Row).id);
        },
      );
      result.stream.controller.abort();
      return { replay, ...result };
    },
  };
}

it("folds a result for an earlier state call and retains native context after a serialized restart", async () => {
  const rows: Row[] = [];
  const fixture = nativeHistory(rows);
  const owner = fixture.record;
  const outbound: import("@anthropic-ai/sdk/resources/beta/sessions/events").BetaManagedAgentsEventParams[] =
    [{ type: "user.message", content: [{ type: "text", text: "test" }] }];
  const context = attachContext(
    outbound,
    [{ description: "mode", value: "quiet" }],
    owner,
  )!;
  const initial = stateCommit(owner, { v: 1 });
  const result = stateCommit({ ...owner, sharedState: initial }, { v: 2 });
  rows.push(
    { ...outbound[1], id: "context", processed_at: at(1) },
    {
      id: "state",
      type: "system.message",
      content: [{ type: "text", text: stateText(initial) }],
      processed_at: at(2),
    },
    {
      id: "write",
      type: "agent.custom_tool_use",
      name: STATE_TOOL,
      input: {},
      processed_at: at(3),
    },
    message("anchor", 4),
  );
  await fixture.recover();
  const restored: SessionRecord = JSON.parse(JSON.stringify(owner));
  restored.sharedState = stateCommit(
    { ...owner, sharedState: result },
    { invalidLocalCache: true },
  );
  restored.runtimeContext = "stale";
  rows.push({
    id: "result",
    type: "user.custom_tool_result",
    custom_tool_use_id: "write",
    is_error: false,
    content: [{ type: "text", text: stateText(result) }],
    processed_at: at(5),
  });
  const warm = await fixture.recover(restored);
  expect(fixture.queries).toEqual([undefined, at(4)]);
  expect(warm.pending).toEqual([]);
  expect(warm.replay).toEqual(["result"]);
  expect(restored.sharedState).toEqual(result);
  expect(restored.runtimeContext).toBe(context.snapshot);
  const { recoveryCheckpoint: _, ...cold } = restored;
  const full = await fixture.recover(cold);
  expect(warm.answeredIds).toEqual(full.answeredIds);
  expect(cold.sharedState).toEqual(restored.sharedState);
  expect(await fixture.recover(restored)).toMatchObject({ replay: [] });
  expect(fixture.queries.at(-1)).toBe(at(5));
});

it("reconciles a changed timestamp boundary and replays only unseen siblings", async () => {
  const rows = [message("old", 0), message("a", 1), message("b", 1)];
  const fixture = nativeHistory(rows);
  await fixture.recover();
  rows.splice(1, 2, message("new", 1), message("b", 1), message("a", 1));
  const result = await fixture.recover();
  expect(fixture.queries).toEqual([undefined, at(1), undefined]);
  expect(result.replay).toEqual(["new"]);
});

it("uses the last verified history boundary when the delivery cursor advanced on a live stream", async () => {
  const rows = [message("anchor", 1)];
  const fixture = nativeHistory(rows);
  await fixture.recover();
  rows.push(message("live", 2), message("offline", 3));
  fixture.record.lastEventId = "live";
  expect((await fixture.recover()).replay).toEqual(["offline"]);
  expect(fixture.queries).toEqual([undefined, at(1)]);
  rows.splice(0, rows.length, message("retained", 4));
  await expect(fixture.recover()).rejects.toMatchObject({
    code: "history_cursor_unavailable",
  });
  expect(fixture.queries.slice(-2)).toEqual([at(3), undefined]);
});

it("retries from the same boundary after a failed page and handles providers without time filters", async () => {
  const rows = [message("anchor", 1)];
  const fixture = nativeHistory(rows);
  await fixture.recover();
  const snapshot = structuredClone(fixture.record);
  rows.push(message("offline", 2));
  fixture.fail(503);
  await expect(fixture.recover()).rejects.toMatchObject({ status: 503 });
  expect(fixture.record).toEqual(snapshot);
  expect(fixture.queries).toEqual([undefined, at(1)]);
  fixture.fail(400);
  expect((await fixture.recover()).replay).toEqual(["offline"]);
  expect(fixture.queries.slice(-2)).toEqual([at(1), undefined]);
});

it("keeps unprocessed history and native child timelines on their existing read path", async () => {
  const rows: Row[] = [
    { ...message("queued", 1), processed_at: null },
    message("tail", 2),
  ];
  const fixture = nativeHistory(rows);
  await fixture.recover();
  expect(fixture.record.recoveryCheckpoint).toBeUndefined();
  rows.shift();
  await fixture.recover();
  expect(fixture.record.recoveryCheckpoint).toBeDefined();
  await fixture.recover({ ...fixture.record, sessionThreadId: "child" });
  expect(fixture.queries).toEqual([undefined, undefined, undefined]);
});

it("recognizes repeated calls and late requires_action for a tool answered before the checkpoint", async () => {
  const call = {
    type: "agent.custom_tool_use",
    id: "old-call",
    name: "backend",
    input: {},
    processed_at: at(1),
  };
  const answer = {
    type: "user.custom_tool_result",
    id: "answer",
    custom_tool_use_id: call.id,
    processed_at: at(2),
  };
  const idle = {
    type: "session.status_idle",
    id: "anchor",
    stop_reason: { type: "end_turn" },
    processed_at: at(3),
  };
  const fake = createFakeClient({
    histories: [[call, answer, idle], [idle]],
    streams: [
      [],
      [
        call,
        {
          ...idle,
          id: "late",
          stop_reason: { type: "requires_action", event_ids: [call.id] },
        },
        { ...idle, id: "done" },
      ],
    ],
  });
  let executions = 0;
  const agent = new ManagedAgentsAgent({
    managedAgentId: "a",
    environmentId: "e",
    client: fake.client,
    resolveSession: () => ({ sessionId: "s" }),
    backendTools: [
      {
        name: "backend",
        description: "",
        parameters: {},
        handler: () => String(++executions),
      },
    ],
  });
  const input = {
    threadId: "t",
    runId: "r",
    tools: [],
    context: [],
    forwardedProps: {},
  };
  await lastValueFrom(agent.run({ ...input, messages: [] }).pipe(toArray()));
  const events = await lastValueFrom(
    agent
      .run({ ...input, messages: [{ role: "user", id: "new", content: "go" }] })
      .pipe(toArray()),
  );
  expect(fake.spies.list.mock.calls.map(([, query]) => query)).toEqual([
    {},
    { "created_at[gte]": at(3), order: "asc" },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
  expect(executions).toBe(0);
  expect(
    fake.sent
      .flatMap((send) => send.events)
      .map((event) => (event as { type: string }).type),
  ).toEqual(["user.message"]);
});
