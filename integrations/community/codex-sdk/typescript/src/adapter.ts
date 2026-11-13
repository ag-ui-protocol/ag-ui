import { AbstractAgent } from "@ag-ui/client";
import {
  EventType,
  PROTOCOL_VERSION,
  type BaseEvent,
  type RunAgentInput,
  type RunFinishedEvent,
  type RunErrorEvent,
} from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { Observable } from "rxjs";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { CodexAdapterError } from "./errors";
import { CodexEventTranslator } from "./events";
import { fingerprint, projectInput } from "./inputs";
import { createCodex, type CodexClient } from "./sdk";
import {
  MemoryCodexSessionStore,
  positiveInteger,
  type CodexSessionRecord,
  type CodexSessionStore,
} from "./sessions";
import type { CodexAgentAdapterConfig } from "./types";

export class CodexAgentAdapter extends AbstractAgent {
  private readonly config: CodexAgentAdapterConfig;
  private readonly store: CodexSessionStore;
  private readonly controllers = new Set<AbortController>();
  private readonly limits: {
    maxInputBytes: number;
    maxMessages: number;
    maxTextBytes: number;
    maxItems: number;
    maxProgressBytes: number;
    runTimeoutMs: number;
  };

  constructor(config: CodexAgentAdapterConfig = {}) {
    super(config);
    this.config = {
      ...config,
      codexOptions: config.codexOptions
        ? structuredClone(config.codexOptions)
        : {},
      threadOptions: config.threadOptions
        ? structuredClone(config.threadOptions)
        : {},
    };
    this.store = config.sessionStore ?? new MemoryCodexSessionStore();
    this.limits = {
      maxInputBytes: positiveInteger(
        config.maxInputBytes ?? 1024 * 1024,
        "maxInputBytes",
      ),
      maxMessages: positiveInteger(config.maxMessages ?? 2000, "maxMessages"),
      maxTextBytes: positiveInteger(
        config.maxTextBytes ?? 4 * 1024 * 1024,
        "maxTextBytes",
      ),
      maxItems: positiveInteger(config.maxItems ?? 1000, "maxItems"),
      maxProgressBytes: positiveInteger(
        config.maxProgressBytes ?? 16 * 1024,
        "maxProgressBytes",
      ),
      runTimeoutMs: positiveInteger(
        config.runTimeoutMs ?? 120000,
        "runTimeoutMs",
      ),
    };
    if (this.limits.runTimeoutMs > 2147483647)
      throw new TypeError("runTimeoutMs must not exceed 2147483647.");
    if (
      config.showReasoning !== undefined &&
      typeof config.showReasoning !== "boolean"
    )
      throw new TypeError("showReasoning must be boolean.");
  }

  override run(rawInput: RunAgentInput): Observable<BaseEvent> {
    return new Observable((observer) => {
      const controller = new AbortController();
      this.controllers.add(controller);
      let completed = false;
      const timer = setTimeout(
        () =>
          controller.abort(
            new CodexAdapterError(
              "RUN_TIMEOUT",
              "The Codex run exceeded its deadline.",
            ),
          ),
        this.limits.runTimeoutMs,
      );
      const execute = async () => {
        let input: RunAgentInput | undefined;
        let acquired = false;
        let invoked = false;
        let record: CodexSessionRecord | undefined;
        let iterator: AsyncGenerator<ThreadEvent> | undefined;
        let iteratorSettled = false;
        let sdk: CodexClient | undefined;
        let disposal: Promise<void> | undefined;
        const beginDisposal = () => {
          if (sdk) {
            disposal ??= Promise.resolve().then(() => sdk?.dispose?.());
            void disposal.catch(() => {});
          }
        };
        let translator: CodexEventTranslator | undefined;
        let terminal: RunFinishedEvent | RunErrorEvent;
        const emit = (events: BaseEvent[]) => {
          for (const event of events) observer.next(event);
        };
        observer.next({
          type: EventType.RUN_STARTED,
          threadId: rawInput.threadId,
          runId: rawInput.runId,
          protocolVersion: PROTOCOL_VERSION,
        });
        try {
          const parsed = RunAgentInputSchema.safeParse(rawInput);
          if (!parsed.success)
            throw new CodexAdapterError(
              "INVALID_INPUT",
              "Request does not match the AG-UI run input schema.",
            );
          input = parsed.data;
          this.store.acquire(input.threadId);
          acquired = true;
          record = this.store.get(input.threadId);
          const projection = projectInput(input, record, this.limits);
          translator = new CodexEventTranslator({
            runId: input.runId,
            showReasoning: this.config.showReasoning,
            ...this.limits,
            maxMessages:
              this.limits.maxMessages - projection.fingerprints.length,
          });
          const nativeId = record?.nativeId;
          record = {
            status: "reserved",
            nativeId,
            fingerprints: projection.fingerprints,
          };
          this.store.set(input.threadId, record);
          if (controller.signal.aborted) throw controller.signal.reason;
          invoked = true;
          sdk = await createCodex(this.config.codexOptions ?? {});
          controller.signal.addEventListener("abort", beginDisposal, {
            once: true,
          });
          if (controller.signal.aborted) beginDisposal();
          if (controller.signal.aborted) throw controller.signal.reason;
          const options: ThreadOptions = {
            sandboxMode: "read-only",
            networkAccessEnabled: false,
            webSearchMode: "disabled",
            approvalPolicy: "never",
            ...this.config.threadOptions,
          };
          const thread = nativeId
            ? sdk.resumeThread(nativeId, options)
            : sdk.startThread(options);
          iterator = (
            await thread.runStreamed(projection.prompt, {
              signal: controller.signal,
            })
          ).events;
          while (true) {
            let next: IteratorResult<ThreadEvent>;
            try {
              next = await iterator.next();
            } catch (error) {
              iteratorSettled = true;
              throw error;
            }
            if (next.done) {
              iteratorSettled = true;
              break;
            }
            try {
              if (controller.signal.aborted) throw controller.signal.reason;
              const event = next.value;
              if (event.type === "thread.started") {
                if (typeof event.thread_id !== "string" || !event.thread_id)
                  throw new CodexAdapterError(
                    "INVALID_SDK_EVENT",
                    "Codex returned an invalid native session identifier.",
                  );
                if (record.nativeId && record.nativeId !== event.thread_id)
                  throw new CodexAdapterError(
                    "STREAM_INCONSISTENT",
                    "Codex changed the native session identifier.",
                  );
                record.nativeId = event.thread_id;
                this.store.set(input.threadId, record);
              }
              emit(translator.push(event));
            } catch (error) {
              controller.abort(error);
              throw error;
            }
          }
          if (controller.signal.aborted) throw controller.signal.reason;
          const final = translator.finish();
          emit(final.events);
          if (!record.nativeId)
            throw new CodexAdapterError(
              "INCOMPLETE_STREAM",
              "Codex did not assign a native session.",
            );
          this.store.set(input.threadId, {
            status: "ready",
            nativeId: record.nativeId,
            fingerprints: [
              ...projection.fingerprints,
              ...final.assistantMessages.map(fingerprint),
            ],
          });
          terminal = {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
            ...(final.usage ? { usage: [final.usage] } : {}),
          };
        } catch (error) {
          if (invoked && acquired && input && record)
            this.store.set(input.threadId, { ...record, status: "failed" });
          emit(translator?.close() ?? []);
          const reason: unknown = controller.signal.reason;
          const safe =
            reason instanceof CodexAdapterError
              ? reason
              : error instanceof CodexAdapterError
                ? error
                : new CodexAdapterError(
                    "CODEX_ERROR",
                    "The Codex run failed. Check host diagnostics and start a new AG-UI thread.",
                  );
          try {
            this.config.onError?.(error);
          } catch {}
          terminal = {
            type: EventType.RUN_ERROR,
            code: safe.code,
            message: safe.message,
          };
        } finally {
          beginDisposal();
          if (iterator) {
            if (!iteratorSettled && controller.signal.aborted) {
              try {
                while (!(await iterator.next()).done) continue;
              } catch {}
            }
            try {
              await iterator.return(undefined);
            } catch {}
          }
          let cleanupVerified = true;
          try {
            await disposal;
          } catch (error) {
            cleanupVerified = false;
            if (acquired && input && record)
              this.store.set(input.threadId, { ...record, status: "failed" });
            try {
              this.config.onError?.(error);
            } catch {}
            terminal = {
              type: EventType.RUN_ERROR,
              code: "CLEANUP_FAILED",
              message:
                "Codex process cleanup could not be confirmed. This thread is unavailable until the host resolves cleanup.",
            };
          }
          if (cleanupVerified && acquired && input)
            this.store.release(input.threadId);
          controller.signal.removeEventListener("abort", beginDisposal);
          clearTimeout(timer);
          this.controllers.delete(controller);
        }
        completed = true;
        observer.next(terminal);
        observer.complete();
      };
      void execute().catch(() => {
        clearTimeout(timer);
        this.controllers.delete(controller);
        observer.error(new Error("Codex session cleanup failed."));
      });
      return () => {
        if (!completed)
          controller.abort(
            new CodexAdapterError("CANCELLED", "The Codex run was cancelled."),
          );
      };
    });
  }

  override abortRun(): void {
    for (const controller of this.controllers)
      controller.abort(
        new CodexAdapterError("CANCELLED", "The Codex run was cancelled."),
      );
  }

  override clone(): CodexAgentAdapter {
    const cloned = new CodexAgentAdapter({
      ...this.config,
      sessionStore: this.store,
      agentId: this.agentId,
      description: this.description,
      threadId: this.threadId,
      initialMessages: structuredClone(this.messages),
      initialState: structuredClone(this.state),
    });
    cloned.subscribers = [...this.subscribers];
    cloned.middlewares = [...this.middlewares];
    cloned.pendingInterrupts = structuredClone(this.pendingInterrupts);
    return cloned;
  }
}
