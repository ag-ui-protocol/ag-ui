import { describe, it, expect } from "vitest";
import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type Message,
  type MessagesSnapshotEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { assembleOps } from "@ag-ui/a2ui-toolkit";
import { Observable, firstValueFrom, toArray } from "rxjs";

import {
  A2UIMiddleware,
  A2UI_HISTORY_METADATA,
  projectA2UIHistory,
} from "../src/index";

const input: RunAgentInput = {
  threadId: "history",
  runId: "run-1",
  messages: [],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
};

const args = {
  surfaceId: "custom",
  components: [{ id: "root", component: "Text", text: "Saved" }],
  data: { value: 3 },
};

const call = {
  id: "render",
  type: "function" as const,
  function: { name: "render_a2ui", arguments: JSON.stringify(args) },
};

const assistant: Message = {
  id: "assistant",
  role: "assistant",
  toolCalls: [call],
};

const result: Message = {
  id: "result",
  role: "tool",
  toolCallId: "render",
  content: '{"status":"rendered"}',
  metadata: { [A2UI_HISTORY_METADATA]: { catalogId: "catalog:historical" } },
};

function snapshot(messages: Message[]): MessagesSnapshotEvent {
  return { type: EventType.MESSAGES_SNAPSHOT, messages };
}

const activities = (messages: Message[]) =>
  messages.filter((m) => m.role === "activity");

/** Scripted agent that replays a fixed event list and records every input it receives. */
class ScriptedAgent extends AbstractAgent {
  public seen: RunAgentInput[] = [];

  constructor(
    private events: BaseEvent[],
    messages: Message[] = [],
  ) {
    super({ initialMessages: messages });
  }

  run(runInput: RunAgentInput): Observable<BaseEvent> {
    this.seen.push(runInput);
    const framed: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: runInput.threadId,
        runId: runInput.runId,
      },
      ...this.events,
      {
        type: EventType.RUN_FINISHED,
        threadId: runInput.threadId,
        runId: runInput.runId,
      },
    ];
    return new Observable((subscriber) => {
      for (const event of framed) subscriber.next(event);
      subscriber.complete();
    });
  }
}

describe("projectA2UIHistory", () => {
  it("recognizes the injected default tool when custom tool names are configured", () => {
    const projected = projectA2UIHistory(snapshot([assistant]), {
      a2uiToolNames: ["custom_renderer"],
      injectA2UITool: true,
    });
    expect(activities(projected.messages)).toEqual([
      expect.objectContaining({
        id: "a2ui-surface-render",
        content: { status: "building" },
      }),
    ]);
  });

  it("rebuilds a surface from the durable catalog and stays idempotent", () => {
    const foreign: Message = {
      id: "foreign",
      role: "activity",
      activityType: "other",
      content: { x: 1 },
    };
    const projected = projectA2UIHistory(
      snapshot([assistant, result, foreign]),
      {
        defaultCatalogId: "catalog:changed",
      },
    );

    expect(activities(projected.messages)[0]).toMatchObject({
      id: "a2ui-surface-render",
      metadata: { [A2UI_HISTORY_METADATA]: { toolCallId: "render" } },
      content: {
        a2ui_operations: [
          {
            version: "v0.9",
            createSurface: {
              surfaceId: "custom",
              catalogId: "catalog:historical",
            },
          },
          expect.anything(),
          expect.anything(),
        ],
      },
    });
    expect(projected.metadata).toEqual({
      "@ag-ui/client": { authoritativeActivityTypes: ["a2ui-surface"] },
    });
    expect(projected.messages).toContainEqual(foreign);
    expect(projectA2UIHistory(projected)).toEqual(projected);
  });

  it("places the surface right after the assistant message that called for it", () => {
    const user: Message = { id: "user", role: "user", content: "show it" };
    const answer: Message = {
      id: "answer",
      role: "assistant",
      content: "Done.",
    };
    const projected = projectA2UIHistory(
      snapshot([user, assistant, result, answer]),
    );

    expect(projected.messages.map((m) => m.id)).toEqual([
      "user",
      "assistant",
      "a2ui-surface-render",
      "result",
      "answer",
    ]);
  });

  it("honours an explicit legacy catalogId argument", () => {
    const legacyCall = {
      ...call,
      function: {
        ...call.function,
        arguments: JSON.stringify({ ...args, catalogId: "basic" }),
      },
    };
    const projected = projectA2UIHistory(
      snapshot([
        { ...assistant, toolCalls: [legacyCall] },
        { ...result, metadata: undefined },
      ]),
    );

    expect(activities(projected.messages)[0]).toMatchObject({
      content: {
        a2ui_operations: [
          expect.objectContaining({
            createSurface: expect.objectContaining({
              catalogId:
                "https://a2ui.org/specification/v0_9/basic_catalog.json",
            }),
          }),
          expect.anything(),
          expect.anything(),
        ],
      },
    });
  });

  it("fails closed when the historical catalog is missing instead of using current config", () => {
    const projected = projectA2UIHistory(
      snapshot([assistant, { ...result, metadata: undefined }]),
      {
        defaultCatalogId: "new",
      },
    );

    expect(activities(projected.messages)).toEqual([
      expect.objectContaining({
        id: "a2ui-surface-render",
        content: {
          status: "failed",
          error: "A2UI history has no durable catalogId",
        },
      }),
    ]);
  });

  it("marks a call without a result as building and a failed result as failed", () => {
    const pending = projectA2UIHistory(snapshot([assistant]));
    expect(activities(pending.messages)[0]).toMatchObject({
      content: { status: "building" },
    });

    const failed = projectA2UIHistory(
      snapshot([assistant, { ...result, content: "", error: "Host failed" }]),
    );
    expect(activities(failed.messages)[0]).toMatchObject({
      content: { status: "failed", error: "Host failed" },
    });
  });

  it("splits a multi-surface result into one activity per surface", () => {
    const outerCall = {
      id: "outer",
      type: "function" as const,
      function: { name: "generate_a2ui", arguments: "{}" },
    };
    const durable: Message[] = [
      { id: "outer-assistant", role: "assistant", toolCalls: [outerCall] },
      {
        id: "outer-result",
        role: "tool",
        toolCallId: "outer",
        content: JSON.stringify({
          a2ui_operations: [
            ...assembleOps({
              intent: "create",
              surfaceId: "a",
              catalogId: "catalog:a",
              components: args.components,
            }),
            ...assembleOps({
              intent: "create",
              surfaceId: "b",
              catalogId: "catalog:b",
              components: args.components,
            }),
          ],
        }),
      },
    ];

    const restored = activities(projectA2UIHistory(snapshot(durable)).messages);
    expect(restored.map((m) => m.id)).toEqual([
      "a2ui-surface-a-outer",
      "a2ui-surface-b-outer",
    ]);
    expect(restored[0]).toMatchObject({
      metadata: { [A2UI_HISTORY_METADATA]: { toolCallId: "outer" } },
      content: {
        a2ui_operations: [
          expect.objectContaining({
            createSurface: { surfaceId: "a", catalogId: "catalog:a" },
          }),
          expect.anything(),
        ],
      },
    });
  });

  it("replaces only its own activity type in the client", async () => {
    const stale: Message = {
      id: "old",
      role: "activity",
      activityType: "a2ui-surface",
      content: {},
    };
    const foreign: Message = {
      id: "foreign",
      role: "activity",
      activityType: "other",
      content: {},
    };
    const agent = new ScriptedAgent(
      [projectA2UIHistory(snapshot([]))],
      [stale, foreign],
    );

    await agent.runAgent(input);

    expect(agent.messages).toEqual([foreign]);
  });
});

describe("A2UIMiddleware live snapshots", () => {
  it("delivers a live tool callback with complete arguments after a lagging snapshot", async () => {
    const complete = JSON.stringify(args);
    const split = complete.indexOf("Saved") + 2;
    const agent = new ScriptedAgent([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "render",
        toolCallName: "render_a2ui",
        parentMessageId: "assistant",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "render",
        delta: complete.slice(0, split),
      } as BaseEvent,
      snapshot([]),
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "render",
        delta: complete.slice(split),
      } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "render" } as BaseEvent,
    ]);
    agent.use(new A2UIMiddleware());
    const calls: string[] = [];
    await agent.runAgent(input, {
      onNewToolCall: ({ toolCall }) => {
        calls.push(toolCall.function.arguments);
      },
    });
    expect(calls).toEqual([complete]);
    expect(
      agent.messages.filter(
        (message) => message.role === "tool" && message.toolCallId === "render",
      ),
    ).toHaveLength(1);
  });

  it("preserves a standalone failure result across lagging snapshots", async () => {
    const content = JSON.stringify({
      code: "a2ui_recovery_exhausted",
      error: "Invalid components",
      attempts: [{ error: "Invalid components" }],
    });
    const report: Message = {
      id: "report",
      role: "assistant",
      toolCalls: [
        {
          id: "report-call",
          type: "function",
          function: { name: "report", arguments: "{}" },
        },
      ],
    };
    const durable: Message = {
      id: "report-result",
      role: "tool",
      toolCallId: "report-call",
      content,
    };
    const stream = await firstValueFrom(
      new A2UIMiddleware()
        .run(
          input,
          new ScriptedAgent([
            {
              type: EventType.TOOL_CALL_START,
              toolCallId: "report-call",
              toolCallName: "report",
              parentMessageId: "report",
            } as BaseEvent,
            {
              type: EventType.TOOL_CALL_END,
              toolCallId: "report-call",
            } as BaseEvent,
            {
              type: EventType.TOOL_CALL_RESULT,
              toolCallId: "report-call",
              messageId: "report-result",
              content,
            } as BaseEvent,
            snapshot([report]),
            snapshot([report, durable]),
          ]),
        )
        .pipe(toArray()),
    );
    for (const event of stream)
      if (event.type === EventType.MESSAGES_SNAPSHOT) {
        expect(activities((event as MessagesSnapshotEvent).messages)).toEqual(
          activities(projectA2UIHistory(snapshot([report, durable])).messages),
        );
      }
  });

  it("preserves standalone result surfaces until their durable result is acknowledged", async () => {
    const report: Message = {
      id: "report",
      role: "assistant",
      toolCalls: [
        {
          id: "report-call",
          type: "function",
          function: { name: "report", arguments: "{}" },
        },
      ],
    };
    const content = JSON.stringify({
      a2ui_operations: [
        ...assembleOps({
          intent: "create",
          surfaceId: "one",
          catalogId: "catalog:one",
          components: args.components,
        }),
        ...assembleOps({
          intent: "create",
          surfaceId: "two",
          catalogId: "catalog:two",
          components: args.components,
        }),
      ],
    });
    const durable: Message = {
      id: "report-result",
      role: "tool",
      toolCallId: "report-call",
      content,
    };
    const stream = await firstValueFrom(
      new A2UIMiddleware()
        .run(
          input,
          new ScriptedAgent([
            {
              type: EventType.TOOL_CALL_START,
              toolCallId: "report-call",
              toolCallName: "report",
              parentMessageId: "report",
            } as BaseEvent,
            {
              type: EventType.TOOL_CALL_END,
              toolCallId: "report-call",
            } as BaseEvent,
            {
              type: EventType.TOOL_CALL_RESULT,
              toolCallId: "report-call",
              messageId: "report-result",
              content,
            } as BaseEvent,
            snapshot([report]),
            snapshot([]),
            snapshot([report, durable]),
          ]),
        )
        .pipe(toArray()),
    );
    const snapshots = stream.filter(
      (event): event is MessagesSnapshotEvent =>
        event.type === EventType.MESSAGES_SNAPSHOT,
    );
    const expected = activities(
      projectA2UIHistory(snapshot([report, durable])).messages,
    );
    for (const current of snapshots)
      expect(activities(current.messages)).toEqual(expected);
  });

  it("keeps painted data through lagging snapshots until the durable result arrives", async () => {
    const foreign: Message = {
      id: "foreign",
      role: "activity",
      activityType: "open-generative-ui",
      content: { html: ["saved"] },
    };
    const later: Message = { id: "later", role: "assistant", content: "Done" };
    const events: BaseEvent[] = [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "render",
        toolCallName: "render_a2ui",
        parentMessageId: "assistant",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "render",
        delta: JSON.stringify(args),
      } as BaseEvent,
      snapshot([assistant]),
      snapshot([]),
      { type: EventType.TOOL_CALL_END, toolCallId: "render" } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "render",
        messageId: "result",
        content: result.content,
      } as BaseEvent,
      snapshot([assistant, later]),
      snapshot([assistant, result]),
    ];
    const stream = await firstValueFrom(
      new A2UIMiddleware({ defaultCatalogId: "catalog:live" })
        .run(input, new ScriptedAgent(events))
        .pipe(toArray()),
    );
    const snapshots = stream.filter(
      (event): event is MessagesSnapshotEvent =>
        event.type === EventType.MESSAGES_SNAPSHOT,
    );
    for (const current of snapshots.slice(0, 3)) {
      expect(activities(current.messages)[0]).toMatchObject({
        id: "a2ui-surface-render",
        content: {
          a2ui_operations: [
            expect.objectContaining({
              createSurface: { surfaceId: "custom", catalogId: "catalog:live" },
            }),
            expect.anything(),
            expect.objectContaining({
              updateDataModel: expect.objectContaining({ value: args.data }),
            }),
          ],
        },
      });
    }
    expect(
      snapshots[2].messages
        .filter((message) => message.role !== "activity")
        .map((message) => message.id),
    ).toEqual(["assistant", "result", "later"]);
    expect(snapshots[3]).toEqual(
      projectA2UIHistory(snapshot([assistant, result])),
    );
    const client = new ScriptedAgent(
      stream.filter(
        (event) =>
          event.type !== EventType.RUN_STARTED &&
          event.type !== EventType.RUN_FINISHED,
      ),
      [foreign],
    );
    await client.runAgent(input);
    expect(client.messages).toContainEqual(foreign);
    expect(
      activities(client.messages).filter(
        (message) => message.activityType === "a2ui-surface",
      ),
    ).toEqual(activities(snapshots[3].messages));
  });
});

describe("A2UIMiddleware readOnly", () => {
  it("projects the snapshot and admits nothing from the caller", async () => {
    const original = snapshot([assistant, result]);
    const next = new ScriptedAgent([original]);
    const events = await firstValueFrom(
      new A2UIMiddleware({ readOnly: true, injectA2UITool: true })
        .run(
          {
            ...input,
            resume: [
              { interruptId: "unsafe", status: "resolved", payload: "execute" },
            ],
            parentRunId: "unsafe-parent",
            messages: [{ id: "unsafe", role: "user", content: "never admit" }],
            state: { unsafe: true },
            context: [{ description: "unsafe", value: "unsafe" }],
            tools: [{ name: "unsafe", description: "unsafe", parameters: {} }],
            forwardedProps: { a2uiAction: {} },
          },
          next,
        )
        .pipe(toArray()),
    );

    expect(next.seen[0]).toEqual({
      ...input,
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    });
    expect(events.filter((e) => e.type === EventType.TOOL_CALL_RESULT)).toEqual(
      [],
    );
    expect(events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT)).toEqual(
      projectA2UIHistory(original),
    );
  });
});

describe("A2UIMiddleware tool result metadata", () => {
  it.each([
    null,
    false,
    3,
    "wrong",
    [],
    { render_a2ui: null },
    { render_a2ui: [] },
    {
      render_a2ui: {
        [A2UI_HISTORY_METADATA]: { catalogId: "forged" },
        foreign: { ok: true },
      },
    },
  ])(
    "stamps the resolved catalog over caller metadata %j",
    async (toolResultMetadata) => {
      const next = new ScriptedAgent([snapshot([])]);
      await firstValueFrom(
        new A2UIMiddleware({ injectA2UITool: true, defaultCatalogId: "actual" })
          .run({ ...input, forwardedProps: { toolResultMetadata } }, next)
          .pipe(toArray()),
      );

      expect(next.seen[0].forwardedProps).toMatchObject({
        toolResultMetadata: {
          render_a2ui: { [A2UI_HISTORY_METADATA]: { catalogId: "actual" } },
        },
      });
    },
  );

  it("records the basic catalog as a fallback when no catalog is configured", async () => {
    const next = new ScriptedAgent([snapshot([])]);
    await firstValueFrom(
      new A2UIMiddleware({ injectA2UITool: true })
        .run(input, next)
        .pipe(toArray()),
    );

    expect(next.seen[0].forwardedProps).toMatchObject({
      toolResultMetadata: {
        render_a2ui: {
          [A2UI_HISTORY_METADATA]: {
            fallbackCatalogId:
              "https://a2ui.org/specification/v0_9/basic_catalog.json",
          },
        },
      },
    });
  });
});
