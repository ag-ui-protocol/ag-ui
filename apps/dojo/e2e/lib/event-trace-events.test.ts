import assert from "node:assert/strict";
import test from "node:test";
import {
  EventTraceSseParseError,
  normalizeEventTrace,
  parseEventTraceSse,
} from "./event-trace-events";
import { assertEventTraceMatches } from "./event-trace-update";

test("parses every ordered non-RAW event without deduplicating snapshots", () => {
  const events = parseEventTraceSse(
    [
      'data: {"type":"RUN_STARTED","threadId":"thread-a","runId":"run-a"}',
      "",
      'data: {"type":"STATE_SNAPSHOT","snapshot":{"count":1}}',
      "",
      'data: {"type":"RAW","event":{"private":true}}',
      "",
      'data: {"type":"STATE_SNAPSHOT","snapshot":{"count":1}}',
      "",
      'data: {"type":"RUN_FINISHED","threadId":"thread-a","runId":"run-a"}',
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["RUN_STARTED", "STATE_SNAPSHOT", "STATE_SNAPSHOT", "RUN_FINISHED"],
  );
});

test("ignores empty SSE data frames", () => {
  const events = parseEventTraceSse(
    [
      "data:",
      "",
      "data:   ",
      "",
      "data",
      "",
      'data: {"type":"RUN_STARTED"}',
      "",
    ].join("\n"),
  );

  assert.deepEqual(events, [{ type: "RUN_STARTED" }]);
});

test("removes transport rawEvent payloads without touching application state", () => {
  assert.deepEqual(
    normalizeEventTrace([
      {
        type: "STATE_SNAPSHOT",
        snapshot: {
          count: 1,
          rawEvent: { applicationOwned: true },
        },
        rawEvent: {
          event: "values",
          data: { transportOnly: true },
        },
      },
    ]),
    [
      {
        type: "STATE_SNAPSHOT",
        snapshot: {
          count: 1,
          rawEvent: { applicationOwned: true },
        },
      },
    ],
  );
});

test("preserves transport-looking field names inside application state", () => {
  const applicationState = {
    rawEvent: {
      id: "chatcmpl-application-value",
      response_metadata: { created_at: 123 },
      metadata: { lc_versions: { application: "keep" } },
    },
    LANGSMITH_PROJECT: "customer-owned",
    langgraph_version: "customer-owned",
    langgraph_auth_user_id: "customer-owned",
  };

  assert.deepEqual(
    normalizeEventTrace([
      { type: "STATE_SNAPSHOT", snapshot: applicationState },
    ]),
    [{ type: "STATE_SNAPSHOT", snapshot: applicationState }],
  );
});

test("collapses identical state snapshot pulses until state changes", () => {
  const repeatedSnapshot = {
    type: "STATE_SNAPSHOT",
    snapshot: { count: 1 },
  };
  const stateDelta = {
    type: "STATE_DELTA",
    delta: [{ op: "replace", path: "/count", value: 1 }],
  };

  assert.deepEqual(
    normalizeEventTrace([
      repeatedSnapshot,
      { type: "STEP_STARTED", stepName: "model" },
      repeatedSnapshot,
      stateDelta,
      repeatedSnapshot,
      repeatedSnapshot,
      { type: "STATE_SNAPSHOT", snapshot: { count: 2 } },
    ]),
    [
      repeatedSnapshot,
      { type: "STEP_STARTED", stepName: "model" },
      stateDelta,
      repeatedSnapshot,
      { type: "STATE_SNAPSHOT", snapshot: { count: 2 } },
    ],
  );
});

test("keeps identical snapshots from separate runs", () => {
  const repeatedSnapshot = {
    type: "STATE_SNAPSHOT",
    snapshot: { count: 1 },
  };

  assert.deepEqual(
    normalizeEventTrace([
      { type: "RUN_STARTED", runId: "first" },
      repeatedSnapshot,
      { type: "RUN_FINISHED", runId: "first" },
      { type: "RUN_STARTED", runId: "second" },
      repeatedSnapshot,
      { type: "RUN_FINISHED", runId: "second" },
    ]).map(({ type }) => type),
    [
      "RUN_STARTED",
      "STATE_SNAPSHOT",
      "RUN_FINISHED",
      "RUN_STARTED",
      "STATE_SNAPSHOT",
      "RUN_FINISHED",
    ],
  );
});

test("normalizes generated identities while retaining their relationships", () => {
  const normalized = normalizeEventTrace([
    {
      type: "TOOL_CALL_START",
      toolCallId: "generated-call",
      toolCallName: "lookup",
      timestamp: 123,
    },
    {
      type: "MESSAGES_SNAPSHOT",
      messages: [
        {
          id: "generated-message",
          role: "assistant",
          toolCalls: [{ id: "generated-call", name: "lookup" }],
        },
        {
          id: "generated-result",
          role: "tool",
          toolCallId: "generated-call",
        },
      ],
    },
  ]);

  assert.deepEqual(normalized, [
    {
      type: "TOOL_CALL_START",
      toolCallId: "id-1",
      toolCallName: "lookup",
    },
    {
      type: "MESSAGES_SNAPSHOT",
      messages: [
        {
          id: "id-2",
          role: "assistant",
          toolCalls: [{ id: "id-1", name: "lookup" }],
        },
        { id: "id-3", role: "tool", toolCallId: "id-1" },
      ],
    },
  ]);
});

test("normalizes subagent run identities while preserving their namespace and references", () => {
  const subagentRunId = "tools:fdecf438-f47b-2e18-3753-b24a141985c2";
  const parentToolCallId = "call_7ctR-vROo_NGnX-w";

  const events = [
    {
      type: "TOOL_CALL_START",
      toolCallId: parentToolCallId,
      toolCallName: "task",
    },
    {
      type: "SUBAGENT_STARTED",
      subagentRunId,
      subagentId: "research-agent",
      parentToolCallId,
    },
    {
      type: "SUBAGENT_FINISHED",
      subagentRunId,
      outcome: { interruptIds: ["generated-interrupt"] },
    },
  ];

  assert.deepEqual(normalizeEventTrace(events), [
    {
      type: "TOOL_CALL_START",
      toolCallId: "id-1",
      toolCallName: "task",
    },
    {
      type: "SUBAGENT_STARTED",
      subagentRunId: "tools:id-2",
      subagentId: "research-agent",
      parentToolCallId: "id-1",
    },
    {
      type: "SUBAGENT_FINISHED",
      subagentRunId: "tools:id-2",
      outcome: { interruptIds: ["id-3"] },
    },
  ]);

  const normalized = normalizeEventTrace(events);
  assert.deepEqual(normalizeEventTrace(normalized), normalized);
});

test("does not reuse canonical identity tokens when normalizing new identities", () => {
  assert.deepEqual(
    normalizeEventTrace([
      {
        type: "SUBAGENT_STARTED",
        subagentRunId: "tools:id-2",
        parentToolCallId: "id-1",
      },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "generated-message",
      },
    ]),
    [
      {
        type: "SUBAGENT_STARTED",
        subagentRunId: "tools:id-2",
        parentToolCallId: "id-1",
      },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "id-3",
      },
    ],
  );
});

test("normalizes application identities without retaining transport payloads", () => {
  const runId = "019fff57-a2dc-76a8-9006-130a727563d9";
  const threadId = "cbf4e664-85d5-48fe-9c3e-f9f6e47102d1";
  // LangGraph checkpoint IDs are UUID-shaped but do not always carry RFC
  // version/variant bits, so identity normalization must accept the shape.
  const checkpointId = "f80e7e50-053d-ad30-c895-22300a175b85";
  const normalized = normalizeEventTrace([
    {
      type: "STATE_SNAPSHOT",
      snapshot: {
        timestamp: "application-owned-timestamp",
        messages: [
          {
            id: "generated-message",
            response_metadata: {
              created_at: 1_786_714_996,
              model_provider: "openai",
            },
          },
        ],
        copilotkit: {
          originalAIMessageId: "message-generated-at-runtime",
          interceptedToolCalls: [{ id: "call_intercepted", name: "lookup" }],
        },
      },
      rawEvent: {
        run_id: runId,
        thread_id: threadId,
        checkpoint_id: checkpointId,
      },
    },
  ]);

  assert.deepEqual(normalized, [
    {
      type: "STATE_SNAPSHOT",
      snapshot: {
        timestamp: "application-owned-timestamp",
        messages: [
          {
            id: "id-1",
            response_metadata: { model_provider: "openai" },
          },
        ],
        copilotkit: {
          originalAIMessageId: "id-2",
          interceptedToolCalls: [{ id: "id-3", name: "lookup" }],
        },
      },
    },
  ]);
});

test("ignores raw transport differences when collapsing adjacent snapshots", () => {
  const messageMirror = {
    type: "STATE_SNAPSHOT",
    rawEvent: {
      event: "messages",
      data: [
        { id: "msg-generated-chunk", content: "hello" },
        { node: "agent" },
      ],
    },
  };
  const eventMirror = {
    type: "STATE_SNAPSHOT",
    rawEvent: {
      event: "events",
      data: {
        event: "on_chat_model_stream",
        data: { chunk: { id: "msg-generated-chunk", content: "hello" } },
      },
    },
  };

  assert.deepEqual(
    normalizeEventTrace([eventMirror, messageMirror]),
    normalizeEventTrace([messageMirror, eventMirror]),
  );
});

test("collapses identical adjacent snapshots independently of raw transport metadata", () => {
  const snapshot = { messages: [{ id: "message-id", role: "assistant" }] };
  const chunk = {
    id: "chunk-id",
    content: "",
    tool_call_chunks: [{ id: "tool-call-id", name: "lookup", args: "" }],
  };
  const messageMirror = {
    type: "STATE_SNAPSHOT",
    snapshot,
    rawEvent: {
      event: "messages",
      data: [chunk, { langgraph_node: "agent" }],
    },
  };
  const eventMirror = {
    type: "STATE_SNAPSHOT",
    snapshot,
    rawEvent: {
      event: "events",
      data: {
        event: "on_chat_model_stream",
        data: { chunk },
        metadata: { langgraph_node: "agent" },
      },
    },
  };

  assert.deepEqual(
    normalizeEventTrace([messageMirror, eventMirror]),
    normalizeEventTrace([eventMirror]),
  );
});

test("collapses identical separated snapshots independently of raw transport metadata", () => {
  const snapshot = { messages: [{ id: "message-id", role: "assistant" }] };
  const chunk = { id: "chunk-id", content: "hello" };
  const messageMirror = {
    type: "STATE_SNAPSHOT",
    snapshot,
    rawEvent: {
      event: "messages",
      data: [chunk, { langgraph_node: "agent" }],
    },
  };
  const eventMirror = {
    type: "STATE_SNAPSHOT",
    snapshot,
    rawEvent: {
      event: "events",
      data: {
        event: "on_chat_model_stream",
        data: { chunk },
        metadata: { langgraph_node: "agent" },
      },
    },
  };
  const separator = { type: "STEP_FINISHED", stepName: "model" };

  assert.deepEqual(
    normalizeEventTrace([messageMirror, separator, eventMirror]),
    normalizeEventTrace([messageMirror, separator]),
  );
  assert.deepEqual(
    normalizeEventTrace([messageMirror, separator, eventMirror]),
    normalizeEventTrace([
      { type: "STATE_SNAPSHOT", snapshot },
      separator,
      { type: "STATE_SNAPSHOT", snapshot },
    ]),
  );
});

test("collapses repeated snapshots independently of how many raw mirrors arrive", () => {
  const snapshot = { messages: [{ id: "message-id", role: "assistant" }] };
  const chunk = { id: "chunk-id", content: "hello" };
  const messageMirror = {
    type: "STATE_SNAPSHOT",
    snapshot,
    rawEvent: {
      event: "messages",
      data: [chunk, { langgraph_node: "agent" }],
    },
  };
  const eventMirror = {
    type: "STATE_SNAPSHOT",
    snapshot,
    rawEvent: {
      event: "events",
      data: {
        event: "on_chat_model_stream",
        data: { chunk },
        metadata: { langgraph_node: "agent" },
      },
    },
  };

  assert.equal(
    normalizeEventTrace([eventMirror, messageMirror, messageMirror]).length,
    1,
  );
});

test("collapses repeated semantic snapshots after raw mirror differences are removed", () => {
  const snapshot = { count: 1 };
  const messageMirror = {
    type: "STATE_SNAPSHOT",
    snapshot,
    rawEvent: {
      event: "messages",
      data: [{ id: "chunk-id", content: "first" }, {}],
    },
  };
  const eventWithDifferentChunk = {
    type: "STATE_SNAPSHOT",
    snapshot,
    rawEvent: {
      event: "events",
      data: {
        event: "on_chat_model_stream",
        data: { chunk: { id: "chunk-id", content: "second" } },
      },
    },
  };
  const eventWithDifferentSnapshot = {
    type: "STATE_SNAPSHOT",
    snapshot: { count: 2 },
    rawEvent: {
      event: "events",
      data: {
        event: "on_chat_model_stream",
        data: { chunk: { id: "chunk-id", content: "first" } },
      },
    },
  };
  const ordinaryRepeat = {
    type: "STATE_SNAPSHOT",
    snapshot,
  };

  assert.equal(
    normalizeEventTrace([messageMirror, eventWithDifferentChunk]).length,
    1,
  );
  assert.equal(
    normalizeEventTrace([messageMirror, eventWithDifferentSnapshot]).length,
    2,
  );
  assert.equal(normalizeEventTrace([ordinaryRepeat, ordinaryRepeat]).length, 1);
});

test("preserves the order of different snapshots sharing a model message ID", () => {
  const messagesSnapshot = {
    type: "STATE_SNAPSHOT",
    snapshot: { count: 1 },
    rawEvent: {
      event: "messages",
      data: [{ id: "chunk-id", content: "first" }, {}],
    },
  };
  const eventsSnapshot = {
    type: "STATE_SNAPSHOT",
    snapshot: { count: 2 },
    rawEvent: {
      event: "events",
      data: {
        event: "on_chat_model_stream",
        data: { chunk: { id: "chunk-id", content: "second" } },
      },
    },
  };
  const ordered = normalizeEventTrace([messagesSnapshot, eventsSnapshot]);
  const reversed = normalizeEventTrace([eventsSnapshot, messagesSnapshot]);

  assert.notDeepEqual(ordered, reversed);
  assert.throws(() => assertEventTraceMatches(reversed, ordered));
});

test("preserves a delayed mirror after intervening state changed", () => {
  const snapshot = { count: 1 };
  const chunk = { id: "chunk-id", content: "first" };
  const eventsSnapshot = {
    type: "STATE_SNAPSHOT",
    snapshot,
    rawEvent: {
      event: "events",
      data: {
        event: "on_chat_model_stream",
        data: { chunk },
      },
    },
  };
  const stateDelta = {
    type: "STATE_DELTA",
    delta: [{ op: "replace", path: "/count", value: 2 }],
  };
  const delayedMessagesSnapshot = {
    type: "STATE_SNAPSHOT",
    snapshot,
    rawEvent: {
      event: "messages",
      data: [chunk, {}],
    },
  };
  const withRestoration = normalizeEventTrace([
    eventsSnapshot,
    stateDelta,
    delayedMessagesSnapshot,
  ]);
  const withoutRestoration = normalizeEventTrace([eventsSnapshot, stateDelta]);

  assert.notDeepEqual(withRestoration, withoutRestoration);
  assert.throws(() =>
    assertEventTraceMatches(withRestoration, withoutRestoration),
  );
});

test("retains the complete SSE response when a data frame is malformed", () => {
  const body = [
    'data: {"type":"RUN_STARTED","threadId":"thread-a","runId":"run-a"}',
    "",
    "data: definitely-not-json",
    "",
  ].join("\n");

  assert.throws(
    () => parseEventTraceSse(body),
    (error) =>
      error instanceof EventTraceSseParseError &&
      error.responseBody === body &&
      error.frameIndex === 1,
  );
});

test("retains application version data while discarding raw metadata", () => {
  const normalized = normalizeEventTrace([
    {
      type: "STATE_SNAPSHOT",
      snapshot: { lc_versions: { application: "keep-me" } },
      rawEvent: {
        metadata: {
          graph_id: "agentic_chat",
          lc_versions: {
            "langchain-core": "1.5.3",
            langchain: "1.3.14",
          },
        },
      },
    },
  ]);

  assert.deepEqual(normalized, [
    {
      type: "STATE_SNAPSHOT",
      snapshot: { lc_versions: { application: "keep-me" } },
    },
  ]);
});

// The App Context envelope the normalizer emits: APP_CONTEXT_PREFIX followed by
// 2-space JSON. Keep these fixtures on the contractual messages surface rather
// than the ignored transport payload.
const appContextContent = (context: Record<string, unknown>) =>
  `App Context:\n${JSON.stringify(context, null, 2)}`;

const systemMessageTrace = (...contents: readonly string[]) => [
  {
    type: "MESSAGES_SNAPSHOT",
    messages: contents.map((content) => ({ role: "system", content })),
  },
];

const appContextTrace = (context: Record<string, unknown>) =>
  systemMessageTrace(appContextContent(context));

// A bag the rewrite must always tokenize. Pairing it with a payload that must
// come back untouched keeps those assertions from passing vacuously: a fixture
// that stopped reaching the rewrite fails on this half.
const CONTROL_BAG = {
  copilotkit_forwarded_headers: { "X-Forwarded-For": "::1" },
};
const CONTROL_REWRITTEN = {
  copilotkit_forwarded_headers: { "x-forwarded-for": "<forwarded-for>" },
};

test("normalizes an App Context thread identity with the surrounding trace", () => {
  const threadId = "8d5cef11-4b0e-4db8-931d-eb2772fc9d7e";
  const normalized = normalizeEventTrace([
    {
      type: "RUN_STARTED",
      threadId,
      runId: "run-a",
    },
    ...appContextTrace({ thread_id: threadId, application_id: threadId }),
  ]);

  assert.deepStrictEqual(normalized, [
    {
      type: "RUN_STARTED",
      threadId: "id-1",
      runId: "id-2",
    },
    ...appContextTrace({
      thread_id: "id-1",
      application_id: threadId,
    }),
  ]);
});

test("normalizes forwarded headers whatever casing reached the agent", () => {
  // The producer selects forwarded headers by matching the `x-` prefix
  // case-insensitively but emits each key verbatim, so the spelling that lands
  // in the payload is not guaranteed to be lowercase. Each row carries
  // different values so a value-passthrough bug cannot hide behind a shared one.
  const spellings: Record<string, Record<string, string>> = {
    lowercase: {
      "x-forwarded-for": "::1",
      "x-forwarded-host": "localhost:8989",
      "x-forwarded-port": "8989",
      "x-forwarded-proto": "http",
    },
    canonical: {
      "X-Forwarded-For": "10.0.0.7",
      "X-Forwarded-Host": "dojo.internal:3000",
      "X-Forwarded-Port": "3000",
      "X-Forwarded-Proto": "https",
    },
    mixed: {
      "X-FORWARDED-for": "192.168.1.4",
      "x-Forwarded-HOST": "ci-runner:9000",
      "X-forwarded-PORT": "9000",
      "x-FORWARDED-Proto": "https",
    },
  };
  const expected = appContextTrace({
    copilotkit_forwarded_headers: {
      "x-forwarded-for": "<forwarded-for>",
      "x-forwarded-host": "<forwarded-host>",
      "x-forwarded-port": "<forwarded-port>",
      "x-forwarded-proto": "<forwarded-proto>",
    },
  });

  for (const [casing, copilotkit_forwarded_headers] of Object.entries(
    spellings,
  )) {
    assert.deepStrictEqual(
      normalizeEventTrace(appContextTrace({ copilotkit_forwarded_headers })),
      expected,
      `${casing} forwarded headers must normalize like the lowercase spelling`,
    );
  }
});

test("tokenizes forwarded headers without touching data owned elsewhere", () => {
  // Only headers the token map names are known to vary by environment. An entry
  // it does not name keeps its spelling and its value, as does a header-shaped
  // key that belongs to the application rather than to the forwarded-header bag.
  const normalized = normalizeEventTrace(
    appContextTrace({
      copilotkit_forwarded_headers: {
        "X-Forwarded-For": "10.0.0.7",
        // An unnamed entry keeps its value exactly, structure included.
        "X-Dojo-Demo": { mode: "agentic-chat" },
      },
      "X-Forwarded-Proto": "app-owned",
      recipe: { "x-forwarded-host": "app-owned" },
    }),
  );

  assert.deepStrictEqual(
    normalized,
    appContextTrace({
      copilotkit_forwarded_headers: {
        "x-forwarded-for": "<forwarded-for>",
        "X-Dojo-Demo": { mode: "agentic-chat" },
      },
      "X-Forwarded-Proto": "app-owned",
      recipe: { "x-forwarded-host": "app-owned" },
    }),
  );
});

test("tokenizes a named header whatever type its value has", () => {
  // A named header's value is environment-dependent whatever shape it arrives
  // in, and a caller can supply the bag directly, so every JSON type is
  // reachable. Asserting the rule across types rather than sampling one keeps
  // substitution from being narrowed to a subset of them later.
  const expected = appContextTrace({
    copilotkit_forwarded_headers: { "x-forwarded-for": "<forwarded-for>" },
  });

  for (const value of ["::1", 8989, "", false, null, { hop: 1 }, ["::1"]]) {
    assert.deepStrictEqual(
      normalizeEventTrace(
        appContextTrace({
          copilotkit_forwarded_headers: { "X-Forwarded-For": value },
        }),
      ),
      expected,
      `value ${JSON.stringify(value)} must not survive tokenization`,
    );
  }
});

test("collapses two spellings of one forwarded header into a single entry", () => {
  // Deliberate: both spellings are the same field, and how many hops spelled it
  // is environment metadata like the values themselves. Order-insensitive,
  // because both entries resolve to the same key and the same token.
  const expected = appContextTrace({
    copilotkit_forwarded_headers: { "x-forwarded-for": "<forwarded-for>" },
  });

  for (const copilotkit_forwarded_headers of [
    { "X-Forwarded-For": "203.0.113.9", "x-forwarded-for": "::1" },
    { "x-forwarded-for": "::1", "X-Forwarded-For": "203.0.113.9" },
  ]) {
    assert.deepStrictEqual(
      normalizeEventTrace(appContextTrace({ copilotkit_forwarded_headers })),
      expected,
    );
  }
});

test("rewrites a forwarded-header bag only when it is record-shaped", () => {
  // Shapes a real trace carries, none of which the rewrite understands. The bag
  // is absent whenever no `x-` header reached the agent, so undefined is the
  // ordinary case rather than a malformed one — and `Object.entries(undefined)`
  // throws. Reshaping a string or an array through `Object.entries` would
  // corrupt it into `{"0": ...}`, so each must come back byte-for-byte.
  const untouched = [
    "Retrieve the recipe, then stop.",
    "App Context:\n{not-json",
    // Compact JSON: the only row that can tell "returned verbatim" apart from
    // "re-serialized", since every appContextContent row is already 2-space.
    'App Context:\n{"copilotkit_forwarded_headers":false}',
    "App Context:\nnull",
    appContextContent({ other: 1 }),
    appContextContent({ copilotkit_forwarded_headers: null }),
    appContextContent({ copilotkit_forwarded_headers: "x-forwarded-for" }),
    appContextContent({ copilotkit_forwarded_headers: ["x-forwarded-for"] }),
    appContextContent({ copilotkit_forwarded_headers: 0 }),
    appContextContent({ copilotkit_forwarded_headers: false }),
  ];

  for (const content of untouched) {
    assert.deepStrictEqual(
      normalizeEventTrace(
        systemMessageTrace(content, appContextContent(CONTROL_BAG)),
      ),
      systemMessageTrace(content, appContextContent(CONTROL_REWRITTEN)),
      content,
    );
  }
});
