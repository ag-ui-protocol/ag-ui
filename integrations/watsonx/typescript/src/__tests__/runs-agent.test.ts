/**
 * Tests for WatsonxRunsAgent (`/v1/orchestrate/runs/stream`).
 *
 * The streams below are synthetic, shaped after events recorded from a
 * watsonx orchestrate instance: NDJSON lines of `{"id","event","data"}`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { WatsonxRunsAgent, InMemoryWatsonxThreadStore } from "../index";
import type {
  WatsonxRunsAgentConfig,
  WatsonxToolResultHandler,
} from "../index";
import { verifyEvents } from "@ag-ui/client";
import {
  EventType,
  PROTOCOL_VERSION,
  type BaseEvent,
  type RunAgentInput,
  type Message,
  type ToolCallArgsEvent,
} from "@ag-ui/core";
import { firstValueFrom, toArray } from "rxjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WXO_THREAD = "wxo-thread-1";

function makeAgent(overrides: Partial<WatsonxRunsAgentConfig> = {}) {
  return new WatsonxRunsAgent({
    region: "eu-de",
    instanceId: "inst-1",
    agentId: "agent-1",
    bearerToken: "tok",
    ...overrides,
  });
}

function makeInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "t-1",
    runId: "r-1",
    messages: [{ id: "m-1", role: "user", content: "Hello" } as Message],
    state: null,
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  };
}

let seq = 0;
function wxo(event: string, data: Record<string, unknown> = {}) {
  return { id: `1700000000000-${seq++}`, event, data };
}

const runStarted = (threadId = WXO_THREAD) =>
  wxo("run.started", {
    run_id: "wxo-run-1",
    agent_id: "agent-1",
    thread_id: threadId,
  });

const textDelta = (text: string) =>
  wxo("message.delta", {
    delta: {
      role: "assistant",
      content: [{ id: "c-1", response_type: "text", text }],
    },
  });

const messageCreated = (text: string) =>
  wxo("message.created", {
    message: {
      id: "msg-1",
      role: "assistant",
      content: [{ response_type: "text", id: "c-1", text }],
    },
  });

const toolCalls = (id: string, name: string, args: unknown) =>
  wxo("run.step.delta", {
    delta: {
      role: "assistant",
      step_details: [{ type: "tool_calls", tool_calls: [{ id, name, args }] }],
    },
  });

// watsonx repeats the call next to its response, without the arguments.
const toolResponse = (id: string, name: string, content: string) =>
  wxo("run.step.delta", {
    delta: {
      role: "assistant",
      step_details: [
        { type: "tool_response", content, name, tool_call_id: id },
        { type: "tool_call", name, tool_call_id: id },
      ],
    },
  });

const done = () => [wxo("run.completed"), wxo("done")];

function ndjson(events: (object | string)[]): string {
  return (
    events
      .map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
      .join("\n") + "\n"
  );
}

function streamResponse(chunks: string[] | string, status = 200): Response {
  const parts = typeof chunks === "string" ? [chunks] : chunks;
  const body = new ReadableStream({
    start(controller) {
      for (const part of parts)
        controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
  return new Response(body, { status });
}

/** Mocks fetch: IAM answers with a token, runs requests get the next response. */
function mockFetch(...responses: Response[]) {
  const runs: {
    url: string;
    init: RequestInit;
    body: Record<string, unknown>;
  }[] = [];
  const fetchMock = vi
    .fn()
    .mockImplementation((url: string, init: RequestInit) => {
      if (url.includes("iam.cloud.ibm.com")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            access_token: "iam-tok",
            expiration: Math.floor(Date.now() / 1000) + 3600,
          }),
        });
      }
      runs.push({ url, init, body: JSON.parse(init.body as string) });
      const response = responses.shift();
      if (!response) throw new Error("unexpected fetch");
      return Promise.resolve(response);
    });
  globalThis.fetch = fetchMock;
  return { fetchMock, runs };
}

async function collectEvents(
  agent: WatsonxRunsAgent,
  input: RunAgentInput = makeInput(),
): Promise<BaseEvent[]> {
  return firstValueFrom(agent.run(input).pipe(verifyEvents(false), toArray()));
}

const types = (events: BaseEvent[]) =>
  events.filter((e) => e.type !== EventType.RAW).map((e) => e.type);

const ofType = <T extends BaseEvent>(events: BaseEvent[], type: EventType) =>
  events.filter((e) => e.type === type) as T[];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WatsonxRunsAgent", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("constructor", () => {
    it("requires apiKey or bearerToken", () => {
      expect(
        () =>
          new WatsonxRunsAgent({
            region: "eu-de",
            instanceId: "i",
            agentId: "a",
          }),
      ).toThrow("WatsonxRunsAgent requires either apiKey or bearerToken");
    });
  });

  describe("text", () => {
    it("streams message.delta as one text message and ignores the repeated message.created", async () => {
      mockFetch(
        streamResponse(
          ndjson([
            runStarted(),
            wxo("message.started"),
            wxo("run.step.intermediate", {
              message: { key: "thinking", text: "Thinking…" },
            }),
            textDelta("Here is "),
            textDelta("the report."),
            messageCreated("Here is the report."),
            wxo("message.completed"),
            ...done(),
          ]),
        ),
      );

      const events = await collectEvents(makeAgent());

      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.RUN_FINISHED,
      ]);
      expect(events[0]).toMatchObject({
        threadId: "t-1",
        runId: "r-1",
        protocolVersion: PROTOCOL_VERSION,
      });
      const deltas = ofType<BaseEvent & { delta: string }>(
        events,
        EventType.TEXT_MESSAGE_CONTENT,
      );
      expect(deltas.map((d) => d.delta).join("")).toBe("Here is the report.");
    });

    it("falls back to message.created when nothing was streamed", async () => {
      mockFetch(
        streamResponse(
          ndjson([runStarted(), messageCreated("Full answer"), ...done()]),
        ),
      );

      const events = await collectEvents(makeAgent());
      const deltas = ofType<BaseEvent & { delta: string }>(
        events,
        EventType.TEXT_MESSAGE_CONTENT,
      );
      expect(deltas.map((d) => d.delta)).toEqual(["Full answer"]);
    });

    it("emits a RAW event for every watsonx event", async () => {
      const stream = [runStarted(), textDelta("Hi"), ...done()];
      mockFetch(streamResponse(ndjson(stream)));

      const events = await collectEvents(makeAgent());
      const raw = ofType<
        BaseEvent & { event: { event: string }; source: string }
      >(events, EventType.RAW);
      expect(raw.map((e) => e.event.event)).toEqual(stream.map((e) => e.event));
      expect(raw.every((e) => e.source === "watsonx")).toBe(true);
    });
  });

  describe("tool calls", () => {
    const CALL = "fc_1";
    const TOOL = "ws1_001_search_schedules_tool";
    const RESULT = JSON.stringify({
      totalrows: 1,
      values: [{ id: 7, plate: "AB-123-CD" }],
    });

    it("maps announced calls and their responses, once each", async () => {
      mockFetch(
        streamResponse(
          ndjson([
            runStarted(),
            textDelta("Looking it up."),
            toolCalls(CALL, TOOL, { date: "2026-10-05" }),
            toolResponse(CALL, TOOL, RESULT),
            textDelta("1 appointment."),
            ...done(),
          ]),
        ),
      );

      const events = await collectEvents(makeAgent());

      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.RUN_FINISHED,
      ]);
      expect(ofType(events, EventType.TOOL_CALL_START)[0]).toMatchObject({
        toolCallId: CALL,
        toolCallName: TOOL,
      });
      expect(ofType(events, EventType.TOOL_CALL_ARGS)[0]).toMatchObject({
        delta: JSON.stringify({ date: "2026-10-05" }),
      });
      expect(ofType(events, EventType.TOOL_CALL_RESULT)[0]).toMatchObject({
        toolCallId: CALL,
        content: RESULT,
        role: "tool",
      });
    });

    // Ordering from IBM's ADK evaluation sample (data1.messages.json): a
    // collaborator's tool response comes first, then the call with its args.
    const callRecord = (id: string, name: string, args: unknown) =>
      wxo("run.step.delta", {
        delta: {
          role: "assistant",
          step_details: [{ type: "tool_call", args, name, tool_call_id: id }],
        },
      });
    const responseOnly = (id: string, name: string, content: string) =>
      wxo("run.step.delta", {
        delta: {
          role: "assistant",
          step_details: [
            { type: "tool_response", content, name, tool_call_id: id },
          ],
        },
      });

    it.each([
      "run.step.intermediate",
      "message.started",
      "message.completed",
      "provider.progress",
    ])("keeps pending arguments across RAW-only %s", async (event) => {
      const args = { user_id: "user-1" };
      mockFetch(
        streamResponse(
          ndjson([
            runStarted(),
            responseOnly(CALL, TOOL, RESULT),
            wxo(event),
            callRecord(CALL, TOOL, args),
            ...done(),
          ]),
        ),
      );
      const onToolResult = vi.fn<WatsonxToolResultHandler>(() => undefined);

      const events = await collectEvents(makeAgent({ onToolResult }));
      expect(
        ofType<ToolCallArgsEvent>(events, EventType.TOOL_CALL_ARGS),
      ).toMatchObject([{ delta: JSON.stringify(args) }]);
      expect(onToolResult).toHaveBeenCalledTimes(1);
      expect(onToolResult.mock.calls[0][0]).toMatchObject({ args });
    });

    it.each([false, true])(
      "uses response-carried arguments and preserves the first result (queued: %s)",
      async (queued) => {
        const args = { user_id: "user-1" };
        mockFetch(
          streamResponse(
            ndjson([
              runStarted(),
              ...(queued ? [responseOnly(CALL, TOOL, RESULT)] : []),
              wxo("run.step.delta", {
                delta: {
                  step_details: [
                    {
                      type: "tool_response",
                      tool_call_id: CALL,
                      name: TOOL,
                      content: queued ? "later duplicate" : RESULT,
                      args,
                    },
                  ],
                },
              }),
              ...done(),
            ]),
          ),
        );
        const onToolResult = vi.fn<WatsonxToolResultHandler>(() => undefined);

        const events = await collectEvents(makeAgent({ onToolResult }));
        expect(
          ofType<ToolCallArgsEvent>(events, EventType.TOOL_CALL_ARGS),
        ).toMatchObject([{ delta: JSON.stringify(args) }]);
        expect(ofType(events, EventType.TOOL_CALL_RESULT)).toMatchObject([
          { content: RESULT },
        ]);
        expect(onToolResult).toHaveBeenCalledTimes(1);
        expect(onToolResult.mock.calls[0][0]).toMatchObject({
          args,
          content: RESULT,
        });
      },
    );

    it("keeps the arguments of a call recorded after its response", async () => {
      const args = { email: "abrennan@workday.net" };
      mockFetch(
        streamResponse(
          ndjson([
            runStarted(),
            wxo("run.step.delta", {
              delta: {
                role: "assistant",
                step_details: [
                  {
                    type: "tool_response",
                    content: RESULT,
                    name: TOOL,
                    tool_call_id: CALL,
                  },
                  { type: "tool_call", args, name: TOOL, tool_call_id: CALL },
                ],
              },
            }),
            ...done(),
          ]),
        ),
      );
      const onToolResult = vi.fn<WatsonxToolResultHandler>(() => undefined);

      const events = await collectEvents(makeAgent({ onToolResult }));
      expect(ofType(events, EventType.TOOL_CALL_ARGS)).toHaveLength(1);
      expect(ofType(events, EventType.TOOL_CALL_ARGS)[0]).toMatchObject({
        delta: JSON.stringify(args),
      });
      expect(onToolResult).toHaveBeenCalledTimes(1);
      expect(onToolResult.mock.calls[0][0]).toMatchObject({ args });
    });

    it("keeps the arguments when the call record comes in a later event", async () => {
      const first = { email: "abrennan@workday.net" };
      const second = { user_id: "6dcb8106" };
      mockFetch(
        streamResponse(
          ndjson([
            runStarted(),
            responseOnly("call-a", "get_user_workday_ids", "ids"),
            callRecord("call-a", "get_user_workday_ids", first),
            responseOnly("call-b", "get_payslips", "payslips"),
            callRecord("call-b", "get_payslips", second),
            textDelta("You do not have any payslips."),
            ...done(),
          ]),
        ),
      );
      const onToolResult = vi.fn<WatsonxToolResultHandler>(() => undefined);

      const events = await collectEvents(makeAgent({ onToolResult }));
      expect(
        ofType<ToolCallArgsEvent>(events, EventType.TOOL_CALL_ARGS).map(
          (e) => e.delta,
        ),
      ).toEqual([JSON.stringify(first), JSON.stringify(second)]);
      expect(onToolResult.mock.calls.map(([result]) => result.args)).toEqual([
        first,
        second,
      ]);
      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.RUN_FINISHED,
      ]);
    });

    it("answers a response whose call never comes before the run moves on", async () => {
      mockFetch(
        streamResponse(
          ndjson([
            runStarted(),
            responseOnly(CALL, TOOL, RESULT),
            textDelta("done"),
            ...done(),
          ]),
        ),
      );

      const events = await collectEvents(makeAgent());
      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.RUN_FINISHED,
      ]);
      expect(ofType(events, EventType.TOOL_CALL_RESULT)[0]).toMatchObject({
        toolCallId: CALL,
        content: RESULT,
      });
    });

    it("announces a call first seen in its response", async () => {
      mockFetch(
        streamResponse(
          ndjson([runStarted(), toolResponse(CALL, TOOL, RESULT), ...done()]),
        ),
      );

      const events = await collectEvents(makeAgent());
      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
        EventType.RUN_FINISHED,
      ]);
      expect(ofType(events, EventType.TOOL_CALL_ARGS)[0]).toMatchObject({
        delta: "{}",
      });
    });

    it("serializes non-string tool responses", async () => {
      const response = toolResponse(CALL, TOOL, "");
      (
        response.data.delta as { step_details: { content: unknown }[] }
      ).step_details[0].content = {
        ok: true,
      };
      mockFetch(streamResponse(ndjson([runStarted(), response, ...done()])));

      const events = await collectEvents(makeAgent());
      expect(ofType(events, EventType.TOOL_CALL_RESULT)[0]).toMatchObject({
        content: '{"ok":true}',
      });
    });

    it("answers calls left without a response before the run ends", async () => {
      mockFetch(
        streamResponse(
          ndjson([runStarted(), toolCalls(CALL, TOOL, {}), ...done()]),
        ),
      );

      const events = await collectEvents(makeAgent());
      const results = ofType(events, EventType.TOOL_CALL_RESULT);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ toolCallId: CALL, content: "" });
      expect(types(events).at(-1)).toBe(EventType.RUN_FINISHED);
    });
  });

  describe("onToolResult", () => {
    const CALL = "fc_1";
    const TOOL = "get_client_by_id_tool";

    it("publishes the returned state as a STATE_SNAPSHOT", async () => {
      mockFetch(
        streamResponse(
          ndjson([
            runStarted(),
            toolCalls(CALL, TOOL, { id: 42 }),
            toolResponse(CALL, TOOL, '{"id":42,"lastname":"Doe"}'),
            ...done(),
          ]),
        ),
      );
      const onToolResult = vi.fn((result, { state }) => ({
        ...state,
        client: JSON.parse(result.content),
      }));

      const events = await collectEvents(
        makeAgent({ onToolResult }),
        makeInput({ state: { selected: "apt-1" } }),
      );

      expect(onToolResult).toHaveBeenCalledTimes(1);
      expect(onToolResult.mock.calls[0][0]).toEqual({
        toolCallId: CALL,
        name: TOOL,
        args: { id: 42 },
        content: '{"id":42,"lastname":"Doe"}',
      });
      expect(onToolResult.mock.calls[0][1].state).toEqual({
        selected: "apt-1",
      });

      const types_ = types(events);
      expect(types_.indexOf(EventType.STATE_SNAPSHOT)).toBe(
        types_.indexOf(EventType.TOOL_CALL_RESULT) + 1,
      );
      expect(ofType(events, EventType.STATE_SNAPSHOT)[0]).toMatchObject({
        snapshot: { selected: "apt-1", client: { id: 42, lastname: "Doe" } },
      });
    });

    it("passes the state returned by the previous call to the next one", async () => {
      mockFetch(
        streamResponse(
          ndjson([
            runStarted(),
            toolResponse("fc_1", TOOL, "a"),
            toolResponse("fc_2", TOOL, "b"),
            ...done(),
          ]),
        ),
      );
      const seen: unknown[] = [];
      const onToolResult = vi.fn((result, { state }) => {
        seen.push(state);
        return {
          results: [...((state?.results as string[]) ?? []), result.content],
        };
      });

      const events = await collectEvents(makeAgent({ onToolResult }));

      expect(seen).toEqual([null, { results: ["a"] }]);
      expect(ofType(events, EventType.STATE_SNAPSHOT).at(-1)).toMatchObject({
        snapshot: { results: ["a", "b"] },
      });
    });

    it("emits no snapshot when the handler returns undefined", async () => {
      mockFetch(
        streamResponse(
          ndjson([runStarted(), toolResponse(CALL, TOOL, "{}"), ...done()]),
        ),
      );

      const events = await collectEvents(
        makeAgent({ onToolResult: () => undefined }),
      );
      expect(ofType(events, EventType.STATE_SNAPSHOT)).toHaveLength(0);
    });
  });

  describe("errors", () => {
    it("maps run.failed to RUN_ERROR after closing the open message", async () => {
      mockFetch(
        streamResponse(
          ndjson([
            runStarted(),
            textDelta("Partial"),
            wxo("run.failed", { last_error: "Tool timed out" }),
          ]),
        ),
      );

      const events = await collectEvents(makeAgent());
      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.RUN_ERROR,
      ]);
      expect(events.at(-1)).toMatchObject({
        message: "watsonx run failed: Tool timed out",
        code: "WATSONX_RUN_FAILED",
      });
    });

    it("reads errors sent as SSE data lines", async () => {
      mockFetch(
        streamResponse(
          ndjson([
            runStarted(),
            `data: ${JSON.stringify(wxo("error", { message: "Bad input" }))}`,
          ]),
        ),
      );

      const events = await collectEvents(makeAgent());
      expect(events.at(-1)).toMatchObject({
        type: EventType.RUN_ERROR,
        message: "watsonx run failed: Bad input",
      });
    });

    it("maps an HTTP error to RUN_ERROR", async () => {
      mockFetch(new Response("nope", { status: 401 }));

      const events = await collectEvents(makeAgent());
      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.RUN_ERROR,
      ]);
      expect(events.at(-1)).toMatchObject({
        message: "watsonx request failed: watsonx returned HTTP 401",
        code: "WATSONX_ERROR",
      });
    });

    it("fails a run without a user message", async () => {
      const { fetchMock } = mockFetch();

      const events = await collectEvents(
        makeAgent(),
        makeInput({
          messages: [
            { id: "m-1", role: "assistant", content: "Hi" } as Message,
          ],
        }),
      );
      expect(events.at(-1)).toMatchObject({
        type: EventType.RUN_ERROR,
        message: "watsonx request failed: no user message to send",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("stream parsing", () => {
    it("reassembles lines split across chunks", async () => {
      const text = ndjson([runStarted(), textDelta("split"), ...done()]);
      const chunks = text.match(/[\s\S]{1,7}/g)!;
      mockFetch(streamResponse(chunks));

      const events = await collectEvents(makeAgent());
      expect(ofType(events, EventType.TEXT_MESSAGE_CONTENT)[0]).toMatchObject({
        delta: "split",
      });
    });

    it("parses a last line without a trailing newline", async () => {
      mockFetch(
        streamResponse(
          ndjson([runStarted()]) + JSON.stringify(textDelta("tail")),
        ),
      );

      const events = await collectEvents(makeAgent());
      expect(ofType(events, EventType.TEXT_MESSAGE_CONTENT)[0]).toMatchObject({
        delta: "tail",
      });
    });

    it("skips SSE fields, comments, [DONE] and invalid lines", async () => {
      mockFetch(
        streamResponse(
          ndjson([
            ": keep-alive",
            "event: message",
            "id: 3",
            "not json",
            '{"no":"event"}',
            runStarted(),
            textDelta("ok"),
            ...done(),
            "data: [DONE]",
          ]),
        ),
      );

      const events = await collectEvents(makeAgent());
      expect(ofType(events, EventType.RAW)).toHaveLength(4);
      expect(types(events).at(-1)).toBe(EventType.RUN_FINISHED);
    });

    it("accepts more than 1MB of lines in a single read", async () => {
      const big = "y".repeat(400 * 1024);
      mockFetch(
        streamResponse(
          ndjson([
            runStarted(),
            textDelta(big),
            textDelta(big),
            textDelta(big),
            ...done(),
          ]),
        ),
      );

      const events = await collectEvents(makeAgent());
      expect(ofType(events, EventType.TEXT_MESSAGE_CONTENT)).toHaveLength(3);
      expect(types(events).at(-1)).toBe(EventType.RUN_FINISHED);
    });

    it("fails a run whose stream ends before the run completed", async () => {
      mockFetch(
        streamResponse(
          ndjson([
            runStarted(),
            textDelta("half an ans"),
            toolCalls("call-1", "lookup", {}),
          ]),
        ),
      );

      const events = await collectEvents(makeAgent());
      expect(types(events).slice(-2)).toEqual([
        EventType.TOOL_CALL_RESULT,
        EventType.RUN_ERROR,
      ]);
      expect(events.at(-1)).toMatchObject({
        code: "WATSONX_RUN_FAILED",
        message: expect.stringContaining(
          "stream ended before the run completed",
        ),
      });
    });

    it("aborts when a line exceeds 1MB", async () => {
      mockFetch(streamResponse("x".repeat(1024 * 1024 + 1)));

      const events = await collectEvents(makeAgent());
      expect(events.at(-1)).toMatchObject({
        type: EventType.RUN_ERROR,
        message: expect.stringContaining("exceeded 1MB"),
      });
    });
  });

  describe("request", () => {
    it("sends the last user message to the runs endpoint", async () => {
      const { runs } = mockFetch(
        streamResponse(ndjson([runStarted(), ...done()])),
      );

      await collectEvents(
        makeAgent({ environmentId: "env-1", timeoutMs: 30_000 }),
        makeInput({
          messages: [
            { id: "m-1", role: "user", content: "First" } as Message,
            { id: "m-2", role: "assistant", content: "Answer" } as Message,
            {
              id: "m-3",
              role: "user",
              content: [{ type: "text", text: " Second " }],
            } as Message,
          ],
        }),
      );

      expect(runs[0].url).toBe(
        "https://api.eu-de.watson-orchestrate.cloud.ibm.com/instances/inst-1/v1/orchestrate/runs/stream?stream_timeout=30000",
      );
      expect(runs[0].init.headers).toMatchObject({
        Authorization: "Bearer tok",
      });
      expect(runs[0].body).toEqual({
        message: { role: "user", content: "Second" },
        agent_id: "agent-1",
        environment_id: "env-1",
      });
    });

    it("forwards forwardedProps without overriding the adapter's keys", async () => {
      const { runs } = mockFetch(
        streamResponse(ndjson([runStarted(), ...done()])),
      );

      await collectEvents(
        makeAgent(),
        makeInput({
          forwardedProps: {
            context: { screen: "dashboard" },
            agent_id: "other",
            thread_id: "other",
            message: "other",
          },
        }),
      );

      expect(runs[0].body).toEqual({
        context: { screen: "dashboard" },
        message: { role: "user", content: "Hello" },
        agent_id: "agent-1",
      });
    });

    it("uses baseUrl when set", async () => {
      const { runs } = mockFetch(
        streamResponse(ndjson([runStarted(), ...done()])),
      );

      await collectEvents(makeAgent({ baseUrl: "http://localhost:4010/" }));
      expect(runs[0].url).toMatch(
        /^http:\/\/localhost:4010\/v1\/orchestrate\/runs\/stream\?/,
      );
    });

    it("exchanges the API key once for an agent and its clones", async () => {
      const { fetchMock } = mockFetch(
        streamResponse(ndjson([runStarted(), ...done()])),
        streamResponse(ndjson([runStarted(), ...done()])),
      );
      const agent = makeAgent({ bearerToken: undefined, apiKey: "key" });

      await collectEvents(agent);
      await collectEvents(agent.clone());

      const iamCalls = fetchMock.mock.calls.filter(([url]) =>
        url.includes("iam.cloud.ibm.com"),
      );
      expect(iamCalls).toHaveLength(1);
      expect(fetchMock.mock.calls.at(-1)![1].headers.Authorization).toBe(
        "Bearer iam-tok",
      );
    });
  });

  describe("threads", () => {
    it("reuses the watsonx thread on the next turn, across clones", async () => {
      const { runs } = mockFetch(
        streamResponse(ndjson([runStarted(), ...done()])),
        streamResponse(ndjson([runStarted(), ...done()])),
      );
      const agent = makeAgent();

      await collectEvents(agent.clone());
      await collectEvents(agent.clone());

      expect(runs[0].body.thread_id).toBeUndefined();
      expect(runs[1].body.thread_id).toBe(WXO_THREAD);
    });

    it("keeps environments apart in a shared store", async () => {
      const threadStore = new InMemoryWatsonxThreadStore();
      const { runs } = mockFetch(
        streamResponse(ndjson([runStarted(), ...done()])),
        streamResponse(ndjson([runStarted("wxo-thread-2"), ...done()])),
      );

      await collectEvents(makeAgent({ threadStore, environmentId: "draft" }));
      await collectEvents(makeAgent({ threadStore, environmentId: "live" }));

      expect(runs[1].body.thread_id).toBeUndefined();
    });

    it("keeps AG-UI threads apart", async () => {
      const { runs } = mockFetch(
        streamResponse(ndjson([runStarted(), ...done()])),
        streamResponse(ndjson([runStarted("wxo-thread-2"), ...done()])),
      );
      const agent = makeAgent();

      await collectEvents(agent);
      await collectEvents(agent, makeInput({ threadId: "t-2" }));

      expect(runs[1].body.thread_id).toBeUndefined();
    });

    it("starts a new watsonx thread once when watsonx no longer knows it", async () => {
      const { runs } = mockFetch(
        streamResponse(ndjson([runStarted("expired"), ...done()])),
        streamResponse(
          ndjson([
            wxo("error", { message: "Thread id expired does not exist" }),
          ]),
        ),
        streamResponse(
          ndjson([runStarted("wxo-new"), textDelta("Hi"), ...done()]),
        ),
        streamResponse(ndjson([runStarted("wxo-new"), ...done()])),
      );
      const agent = makeAgent();

      await collectEvents(agent);
      const events = await collectEvents(agent);
      await collectEvents(agent);

      expect(runs.map((r) => r.body.thread_id)).toEqual([
        undefined,
        "expired",
        undefined,
        "wxo-new",
      ]);
      expect(types(events).at(-1)).toBe(EventType.RUN_FINISHED);
    });

    it("does not retry once events were shown", async () => {
      const { runs } = mockFetch(
        streamResponse(ndjson([runStarted("expired"), ...done()])),
        streamResponse(
          ndjson([
            textDelta("Partial"),
            wxo("error", { message: "Thread id expired does not exist" }),
          ]),
        ),
      );

      const agent = makeAgent();

      await collectEvents(agent);
      const events = await collectEvents(agent);

      expect(runs.map((r) => r.body.thread_id)).toEqual([undefined, "expired"]);
      expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR });
    });

    it("supports asynchronous stores", async () => {
      const stored = new Map<string, string>();
      const threadStore = {
        get: async (key: string) => stored.get(key),
        set: async (key: string, id: string) => void stored.set(key, id),
        delete: async (key: string) => void stored.delete(key),
      };
      const { runs } = mockFetch(
        streamResponse(ndjson([runStarted(), ...done()])),
        streamResponse(ndjson([runStarted(), ...done()])),
      );
      const agent = makeAgent({ threadStore });

      await collectEvents(agent);
      await collectEvents(agent);

      expect(runs[1].body.thread_id).toBe(WXO_THREAD);
    });

    it("evicts the oldest thread past the store's capacity", () => {
      const store = new InMemoryWatsonxThreadStore(2);
      store.set("a", "1");
      store.set("b", "2");
      store.set("a", "1'");
      store.set("c", "3");

      expect(store.get("b")).toBeUndefined();
      expect(store.get("a")).toBe("1'");
      expect(store.get("c")).toBe("3");
    });
  });

  describe("abort", () => {
    it("aborts the request when the subscription ends", async () => {
      let signal: AbortSignal | undefined;
      globalThis.fetch = vi
        .fn()
        .mockImplementation((_url: string, init: RequestInit) => {
          signal = init.signal ?? undefined;
          return new Promise(() => {});
        });

      const subscription = makeAgent().run(makeInput()).subscribe();
      await vi.waitFor(() => expect(signal).toBeDefined());
      subscription.unsubscribe();

      expect(signal!.aborted).toBe(true);
    });

    it("aborts the active run on abortRun()", async () => {
      let signal: AbortSignal | undefined;
      globalThis.fetch = vi
        .fn()
        .mockImplementation((_url: string, init: RequestInit) => {
          signal = init.signal ?? undefined;
          return new Promise((_, reject) =>
            init.signal!.addEventListener("abort", () =>
              reject(new Error("aborted")),
            ),
          );
        });
      const agent = makeAgent();

      const events: BaseEvent[] = [];
      const completed = new Promise<void>((resolve) =>
        agent
          .run(makeInput())
          .subscribe({ next: (e) => events.push(e), complete: resolve }),
      );
      await vi.waitFor(() => expect(signal).toBeDefined());
      agent.abortRun();
      await completed;

      expect(signal!.aborted).toBe(true);
      expect(types(events)).toEqual([EventType.RUN_STARTED]);
    });
  });
});
