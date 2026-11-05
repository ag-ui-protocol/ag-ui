import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EventType,
  type MessagesSnapshotEvent,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/core";
import {
  BeforeToolCallEvent,
  FileStorage,
  FunctionTool,
  SessionManager,
  type ModelStreamEvent,
  type Plugin,
} from "@strands-agents/sdk";
import { AG_UI_FRONTEND_CALL_IDS_STATE_KEY } from "../session-reconcile";
import {
  collect,
  errorCodes,
  expectCompletedRun,
  minimalRunInput,
  modelTurn,
  persistedSnapshot,
  persistedToolResults,
  realStrandsAgent,
  soleInterruptId,
  threadAgent,
} from "./helpers";

const richNames = ["pieChart", "barChart", "generateSandboxedUi"];
const tools = richNames.map((name) => ({
  name,
  description: "Render native output",
  parameters: { type: "object", properties: {} },
}));

function lastMessages(events: BaseEvent[]) {
  const snapshot = events
    .filter(
      (event): event is MessagesSnapshotEvent =>
        event.type === EventType.MESSAGES_SNAPSHOT,
    )
    .at(-1);
  expect(snapshot).toBeDefined();
  return snapshot!.messages;
}

const approvalPlugin: Plugin = {
  name: "native-approval",
  initAgent(agent) {
    agent.addHook(BeforeToolCallEvent, (event) => {
      if (event.toolUse.name === "approve") {
        event.interrupt({ name: "approve", reason: "Approve shipment?" });
      }
    });
  },
};

describe("native tools shadowing client declarations", () => {
  it("resumes approval after persisted rich tools and survives cold restore without duplicate execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agui-native-ownership-"));
    try {
      const nativeTools = [...richNames, "approve"].map((name) => {
        const calls: unknown[] = [];
        return {
          calls,
          tool: new FunctionTool({
            name,
            description: "Native rich tool",
            callback: (input) => {
              calls.push(input);
              return JSON.stringify({ points: [2, 4], tool: name });
            },
          }),
        };
      });
      const boot = (turns: ModelStreamEvent[][]) =>
        realStrandsAgent(turns, {
          tools: nativeTools.map((entry) => entry.tool),
          plugins: [approvalPlugin],
          config: {
            sessionManagerProvider: () =>
              new SessionManager({
                sessionId: "native-ownership-session",
                storage: { snapshot: new FileStorage(dir) },
              }),
          },
        });
      const first = boot([
        modelTurn.toolUse(
          ...richNames.map((name) => ({ name, toolUseId: `rich-${name}` })),
        ),
        modelTurn.text("Rich tools complete"),
      ]);
      const rich = await collect(first.agent, minimalRunInput({ tools }));
      expectCompletedRun(rich);
      const richResults = persistedToolResults(dir);
      expect(richResults.map((result) => result.toolUseId).sort()).toEqual(
        richNames.map((name) => `rich-${name}`).sort(),
      );
      const approval = boot([
        modelTurn.toolUse({ name: "approve", toolUseId: "approval-1" }),
      ]);
      const paused = await collect(
        approval.agent,
        minimalRunInput({
          tools,
          messages: [
            ...lastMessages(rich),
            {
              id: "request-approval",
              role: "user",
              content: "Approve shipment",
            },
          ],
        }),
      );
      const interruptId = soleInterruptId(paused);
      expect(nativeTools.at(-1)!.calls).toEqual([]);
      const resume: RunAgentInput = minimalRunInput({
        tools,
        messages: lastMessages(paused),
        resume: [
          { interruptId, status: "resolved", payload: { approved: true } },
        ],
      });

      // Only the on-disk SDK snapshot connects these two adapter instances.
      const restarted = boot([modelTurn.text("Approved")]);
      const resumed: BaseEvent[] = [];
      for await (const event of restarted.agent.run(resume)) {
        resumed.push(event);
        // A client may disconnect as soon as it receives the terminal event.
        if (event.type === EventType.RUN_FINISHED) break;
      }
      expectCompletedRun(resumed, "cold resume");
      expect(nativeTools.map((entry) => entry.calls.length)).toEqual([
        1, 1, 1, 1,
      ]);
      expect(restarted.model.calls).toBe(1);
      const saved = persistedToolResults(dir);
      expect(
        saved.filter((result) => result.toolUseId !== "approval-1"),
      ).toEqual(richResults);
      expect(
        saved.filter((result) => result.toolUseId === "approval-1"),
      ).toHaveLength(1);
      expect(
        persistedSnapshot(dir).data.state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY] ??
          [],
      ).toEqual([]);

      // An exact completed resume remains idempotent after an immediate restart.
      const reloaded = boot([]);
      expectCompletedRun(await collect(reloaded.agent, resume), "cold replay");
      expect(reloaded.model.calls).toBe(0);
      expect(nativeTools.map((entry) => entry.calls.length)).toEqual([
        1, 1, 1, 1,
      ]);
      expect(persistedToolResults(dir)).toEqual(saved);
      expect(
        threadAgent(reloaded.agent)?.messages.map((message) =>
          message.toJSON(),
        ),
      ).toEqual(persistedSnapshot(dir).data.messages);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mixed native and frontend ownership", () => {
  it("keeps a genuine frontend sibling pending while a shadowing native tool executes once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agui-mixed-ownership-"));
    try {
      const calls: unknown[] = [];
      const native = new FunctionTool({
        name: "pieChart",
        description: "Render native chart",
        callback: (input) => {
          calls.push(input);
          return JSON.stringify({ points: [2, 4] });
        },
      });
      const declarations = [
        tools[0]!,
        {
          name: "pickColor",
          description: "Ask the client to select a color",
          parameters: { type: "object", properties: {} },
        },
      ];
      const boot = (turns: ModelStreamEvent[][]) =>
        realStrandsAgent(turns, {
          tools: [native],
          config: {
            sessionManagerProvider: () =>
              new SessionManager({
                sessionId: "mixed-ownership-session",
                storage: { snapshot: new FileStorage(dir) },
              }),
          },
        });
      const first = boot([
        modelTurn.toolUse(
          { name: "pieChart", toolUseId: "native-chart" },
          { name: "pickColor", toolUseId: "frontend-color" },
        ),
        modelTurn.text("Must wait for the client"),
      ]);
      const paused = await collect(
        first.agent,
        minimalRunInput({ tools: declarations }),
      );
      expect(errorCodes(paused)).toEqual([]);
      expect(first.model.calls).toBe(1);
      expect(calls).toHaveLength(1);
      expect(
        persistedSnapshot(dir).data.state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY],
      ).toEqual(["frontend-color"]);
      const nativeResult = persistedToolResults(dir).find(
        (result) => result.toolUseId === "native-chart",
      );
      expect(nativeResult).toEqual({
        toolUseId: "native-chart",
        status: "success",
        content: [{ text: JSON.stringify({ points: [2, 4] }) }],
      });

      const restarted = boot([modelTurn.text("The chart is blue")]);
      const completed = await collect(
        restarted.agent,
        minimalRunInput({
          runId: "mixed-resume",
          tools: declarations,
          messages: [
            ...lastMessages(paused),
            {
              id: "color-result",
              role: "tool",
              toolCallId: "frontend-color",
              content: "blue",
            },
          ],
        }),
      );
      expectCompletedRun(completed, "mixed frontend continuation");
      expect(restarted.model.calls).toBe(1);
      expect(calls).toHaveLength(1);
      expect(persistedToolResults(dir)).toEqual([
        nativeResult,
        {
          toolUseId: "frontend-color",
          status: "success",
          content: [{ text: "blue" }],
        },
      ]);
      expect(
        persistedSnapshot(dir).data.state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY] ??
          [],
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
