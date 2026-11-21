import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import {
  BeforeToolCallEvent,
  FileStorage,
  FunctionTool,
  SessionManager,
  type Plugin,
} from "@strands-agents/sdk";
import {
  collect,
  errorCodes,
  expectCompletedRun,
  minimalRunInput,
  modelTurn,
  persistedSnapshot,
  realStrandsAgent,
  soleInterruptId,
  threadAgent,
} from "./helpers";

import { StrandsAgent } from "../agent";

const BOOKKEEPING = "ag_ui_interrupt_bookkeeping";
const approval: Plugin = {
  name: "approval",
  initAgent(agent) {
    agent.addHook(BeforeToolCallEvent, (event) => {
      event.interrupt({ name: "approval", reason: "Approve?" });
    });
  },
};

describe.each([false, true])(
  "completed resume persistence (chunks=%s)",
  (emitChunkEvents) => {
    it.each(["appState", "snapshot"])(
      "reports %s write failures without acknowledging durable success",
      async (failure) => {
        const dir = mkdtempSync(join(tmpdir(), "agui-resume-persistence-"));
        try {
          const callback = vi.fn(() => JSON.stringify({ done: true }));
          const session = new SessionManager({
            sessionId: "completed-resume",
            storage: { snapshot: new FileStorage(dir) },
          });
          const setup = realStrandsAgent(
            [
              modelTurn.toolUse({ name: "approve", toolUseId: "approval-1" }),
              [
                ...modelTurn.text("Approved"),
                {
                  type: "modelMetadataEvent",
                  usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
                },
              ],
            ],
            {
              tools: [
                new FunctionTool({
                  name: "approve",
                  description: "Approve",
                  callback,
                }),
              ],
              plugins: [approval],
              config: {
                emitChunkEvents,
                sessionManagerProvider: () => session,
              },
            },
          );
          const interruptId = soleInterruptId(
            await collect(setup.agent, minimalRunInput()),
          );
          const core = threadAgent(setup.agent)!;
          const cause = new Error("completed resume write failed");
          const write = core.appState.set.bind(core.appState);
          const snapshot = session.saveSnapshot.bind(session);
          let markSaving!: () => void;
          const saving = new Promise<void>((resolve) => {
            markSaving = resolve;
          });
          let releaseSave!: () => void;
          const saveReleased = new Promise<void>((resolve) => {
            releaseSave = resolve;
          });
          // Fail only the new completion fingerprint; SDK invocation snapshots
          // still succeed, so execution has completed and cannot be rolled back.
          if (failure === "appState") {
            vi.spyOn(core.appState, "set").mockImplementation((key, value) => {
              if (
                key === BOOKKEEPING &&
                value &&
                typeof value === "object" &&
                "lastResumeFingerprint" in value &&
                value.lastResumeFingerprint
              )
                throw cause;
              return write(key, value);
            });
          } else {
            vi.spyOn(session, "saveSnapshot").mockImplementation(
              async (options) => {
                const data = core.appState.get(BOOKKEEPING);
                if (
                  data &&
                  typeof data === "object" &&
                  "lastResumeFingerprint" in data &&
                  data.lastResumeFingerprint
                ) {
                  markSaving();
                  await saveReleased;
                  throw cause;
                }
                return snapshot(options);
              },
            );
          }
          const otherWrapper = new StrandsAgent({
            agent: setup.template,
            name: "test",
            agentsByThread: new Map([["thread-1", core]]),
            config: { emitChunkEvents },
          });
          const resume = minimalRunInput({
            resume: [
              { interruptId, status: "resolved", payload: { approved: true } },
            ],
          });
          const collecting = collect(setup.agent, resume);
          if (failure === "snapshot") {
            await saving;
            try {
              // The completion receipt is staged in appState but is not yet
              // durable. An overlapping retry must not cache or acknowledge it.
              const overlapping = await collect(setup.agent, resume);
              expect(errorCodes(overlapping)).toEqual(["UNKNOWN_INTERRUPT_ID"]);
              // Request-scoped wrappers share the native agent, not the
              // adapter-local active-run guard. Do not cache a staged receipt.
              const sharedRetry = await collect(otherWrapper, resume);
              expect(errorCodes(sharedRetry)).toEqual(["UNKNOWN_INTERRUPT_ID"]);
              expect(
                sharedRetry.some(
                  (event) => event.type === EventType.RUN_FINISHED,
                ),
              ).toBe(false);
            } finally {
              releaseSave();
            }
          }
          const events = await collecting;
          expect(errorCodes(events)).toEqual(["STRANDS_ERROR"]);
          expect(
            events.filter((event) => event.type === EventType.RUN_FINISHED),
          ).toEqual([]);
          expect(events.at(-1)).toMatchObject({
            type: EventType.RUN_ERROR,
            message: cause.message,
            usage: [
              {
                model: "scripted-model",
                inputTokens: 12,
                outputTokens: 4,
                totalTokens: 16,
              },
            ],
          });
          expect(callback).toHaveBeenCalledTimes(1);
          expect(persistedSnapshot(dir).data.state[BOOKKEEPING]).toMatchObject({
            lastResumeFingerprint: null,
          });

          // Failure must not leave an in-memory/appState success shortcut. The
          // completed tool is not re-executed, and retry reports the missing checkpoint.
          expect(errorCodes(await collect(setup.agent, resume))).toEqual([
            "UNKNOWN_INTERRUPT_ID",
          ]);
          expect(errorCodes(await collect(otherWrapper, resume))).toEqual([
            "UNKNOWN_INTERRUPT_ID",
          ]);
          const cold = realStrandsAgent([], {
            config: {
              sessionManagerProvider: () =>
                new SessionManager({
                  sessionId: "completed-resume",
                  storage: { snapshot: new FileStorage(dir) },
                }),
            },
          });
          expect(errorCodes(await collect(cold.agent, resume))).toEqual([
            "UNKNOWN_INTERRUPT_ID",
          ]);
          expect(cold.model.calls).toBe(0);
          expect(callback).toHaveBeenCalledTimes(1);
        } finally {
          vi.restoreAllMocks();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  },
);

describe.each([false, true])(
  "completion exclusion (chunks=%s)",
  (emitChunkEvents) => {
    it.each([false, true])(
      "blocks shared-agent fresh input until completion save settles (reject=%s)",
      async (rejectSave) => {
        const dir = mkdtempSync(join(tmpdir(), "agui-completion-exclusion-"));
        try {
          const callback = vi.fn(() => JSON.stringify({ approved: true }));
          const session = new SessionManager({
            sessionId: "completion-exclusion",
            storage: { snapshot: new FileStorage(dir) },
          });
          const setup = realStrandsAgent(
            [
              modelTurn.toolUse({ name: "approve", toolUseId: "approval-1" }),
              modelTurn.text("Approved"),
              modelTurn.text("Next answer"),
            ],
            {
              tools: [
                new FunctionTool({
                  name: "approve",
                  description: "Approve",
                  callback,
                }),
              ],
              plugins: [approval],
              config: {
                emitChunkEvents,
                sessionManagerProvider: () => session,
              },
            },
          );
          const interruptId = soleInterruptId(
            await collect(setup.agent, minimalRunInput()),
          );
          const core = threadAgent(setup.agent)!;
          let markSaving!: () => void;
          const saving = new Promise<void>((resolve) => {
            markSaving = resolve;
          });
          let releaseSave!: () => void;
          const released = new Promise<void>((resolve) => {
            releaseSave = resolve;
          });
          const snapshot = session.saveSnapshot.bind(session);
          let deferCompletion = true;
          vi.spyOn(session, "saveSnapshot").mockImplementation(
            async (options) => {
              const receipt = core.appState.get(BOOKKEEPING);
              if (
                deferCompletion &&
                receipt &&
                typeof receipt === "object" &&
                "lastResumeFingerprint" in receipt &&
                receipt.lastResumeFingerprint
              ) {
                deferCompletion = false;
                markSaving();
                await released;
                if (rejectSave) throw new Error("completion save failed");
              }
              return snapshot(options);
            },
          );
          const selectTools = vi.fn(() => null);
          const wrapper = new StrandsAgent({
            agent: setup.template,
            name: "test",
            agentsByThread: new Map([["thread-1", core]]),
            config: { emitChunkEvents, templateToolsProvider: selectTools },
          });
          const resumeRun = collect(
            setup.agent,
            minimalRunInput({
              resume: [{ interruptId, status: "resolved", payload: true }],
            }),
          );
          await saving;
          const before = JSON.stringify({
            messages: core.messages,
            state: core.appState.getAll(),
          });
          const calls = setup.model.calls;
          const fresh = minimalRunInput({
            messages: [{ id: "next", role: "user", content: "Next question" }],
            tools: [
              { name: "newFrontendTool", description: "new", parameters: {} },
            ],
          });
          let blocked;
          try {
            blocked = await collect(wrapper, fresh);
            expect(
              JSON.stringify({
                messages: core.messages,
                state: core.appState.getAll(),
              }),
            ).toBe(before);
          } finally {
            releaseSave();
          }
          const completed = await resumeRun;
          expect(errorCodes(blocked)).toEqual(["THREAD_BUSY"]);
          expect(selectTools).not.toHaveBeenCalled();
          expect(setup.model.calls).toBe(calls);
          expect(callback).toHaveBeenCalledTimes(1);
          expect(core.toolRegistry.get("newFrontendTool")).toBeUndefined();
          expect(
            blocked.some((event) => event.type === EventType.STATE_SNAPSHOT),
          ).toBe(false);
          if (rejectSave)
            expect(errorCodes(completed)).toEqual(["STRANDS_ERROR"]);
          else expectCompletedRun(completed);
          expectCompletedRun(await collect(wrapper, fresh));
          expect(setup.model.calls).toBe(calls + 1);
          expect(selectTools).toHaveBeenCalledTimes(1);
        } finally {
          vi.restoreAllMocks();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  },
);

describe.each([false, true])(
  "shared native-agent lease (chunks=%s)",
  (emitChunkEvents) => {
    it("excludes async setup interleaving and holds through terminal consumer return", async () => {
      const dir = mkdtempSync(join(tmpdir(), "agui-shared-lease-"));
      try {
        const session = new SessionManager({
          sessionId: "shared-lease",
          storage: { snapshot: new FileStorage(dir) },
        });
        const callback = vi.fn(() => JSON.stringify({ approved: true }));
        const setup = realStrandsAgent(
          [
            modelTurn.toolUse({ name: "approve", toolUseId: "approval-1" }),
            modelTurn.text("Approved"),
            modelTurn.text("Next answer"),
          ],
          {
            tools: [
              new FunctionTool({
                name: "approve",
                description: "Approve",
                callback,
              }),
            ],
            plugins: [approval],
            config: { sessionManagerProvider: () => session },
          },
        );
        const interruptId = soleInterruptId(
          await collect(setup.agent, minimalRunInput()),
        );
        const core = threadAgent(setup.agent)!;
        let enterSetup!: () => void;
        const settingUp = new Promise<void>((resolve) => {
          enterSetup = resolve;
        });
        let releaseSetup!: () => void;
        const setupReleased = new Promise<void>((resolve) => {
          releaseSetup = resolve;
        });
        let enterSave!: () => void;
        const saving = new Promise<void>((resolve) => {
          enterSave = resolve;
        });
        let releaseSave!: () => void;
        const saveReleased = new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        const snapshot = session.saveSnapshot.bind(session);
        vi.spyOn(session, "saveSnapshot").mockImplementation(
          async (options) => {
            const receipt = core.appState.get(BOOKKEEPING);
            if (
              receipt &&
              typeof receipt === "object" &&
              "lastResumeFingerprint" in receipt &&
              receipt.lastResumeFingerprint
            ) {
              enterSave();
              await saveReleased;
            }
            return snapshot(options);
          },
        );
        const owner = new StrandsAgent({
          agent: setup.template,
          name: "test",
          agentsByThread: new Map([["thread-1", core]]),
          config: {
            emitChunkEvents,
            templateToolsProvider: async () => {
              enterSetup();
              await setupReleased;
              return null;
            },
          },
        });
        const contender = new StrandsAgent({
          agent: setup.template,
          name: "test",
          agentsByThread: new Map([["thread-1", core]]),
          config: { emitChunkEvents },
        });
        const resume = minimalRunInput({
          resume: [{ interruptId, status: "resolved", payload: true }],
        });
        const stream = owner.run(resume);
        const terminal = (async () => {
          while (true) {
            const next = await stream.next();
            if (
              next.done ||
              next.value.type === EventType.RUN_FINISHED ||
              next.value.type === EventType.RUN_ERROR
            )
              return next;
          }
        })();
        try {
          await settingUp;
          const attempts = collect(contender, resume);
          // Baseline may reach save; do not deadlock the failing regression.
          releaseSave();
          expect(errorCodes(await attempts)).toEqual(["THREAD_BUSY"]);
          expect(setup.model.calls).toBe(1);
          expect(callback).not.toHaveBeenCalled();
          releaseSetup();
          await saving;
          const finished = await terminal;
          expect(finished.value).toMatchObject({
            type: EventType.RUN_FINISHED,
          });
          // The underlying generator is suspended at its terminal yield. Only
          // consumer return (or exhaustion) may release its native-agent lease.
          expect(
            errorCodes(await collect(contender, minimalRunInput())),
          ).toEqual(["THREAD_BUSY"]);
        } finally {
          releaseSetup();
          releaseSave();
          await terminal;
          await stream.return();
        }
        expectCompletedRun(await collect(contender, minimalRunInput()));
        expect(setup.model.calls).toBe(3);
        expect(callback).toHaveBeenCalledTimes(1);
      } finally {
        vi.restoreAllMocks();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("releases the lease after asynchronous setup failure", async () => {
      const setup = realStrandsAgent([
        modelTurn.text("Warm"),
        modelTurn.text("Recovered"),
      ]);
      await collect(setup.agent, minimalRunInput());
      const core = threadAgent(setup.agent)!;
      let enterSetup!: () => void;
      const settingUp = new Promise<void>((resolve) => {
        enterSetup = resolve;
      });
      let releaseSetup!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseSetup = resolve;
      });
      const owner = new StrandsAgent({
        agent: setup.template,
        name: "test",
        agentsByThread: new Map([["thread-1", core]]),
        config: {
          emitChunkEvents,
          templateToolsProvider: async () => {
            enterSetup();
            await released;
            throw new Error("setup failed");
          },
        },
      });
      const running = collect(owner, minimalRunInput());
      await settingUp;
      try {
        expect(
          errorCodes(await collect(setup.agent, minimalRunInput())),
        ).toEqual(["THREAD_BUSY"]);
        expect(setup.model.calls).toBe(1);
      } finally {
        releaseSetup();
      }
      expect(errorCodes(await running)).toEqual([
        "TEMPLATE_TOOLS_PROVIDER_ERROR",
      ]);
      expectCompletedRun(await collect(setup.agent, minimalRunInput()));
      expect(setup.model.calls).toBe(2);
    });
  },
);
