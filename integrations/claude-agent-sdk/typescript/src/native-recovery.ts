import { buildAguiToolMessage } from "./utils";
import { isDeepStrictEqual } from "node:util";
import { spawn, type ChildProcess } from "node:child_process";
import {
  query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
  type HookCallback,
} from "@anthropic-ai/claude-agent-sdk";
import type { RunAgentInput, RunFinishedOutcome } from "@ag-ui/core";
import {
  NativeHistory,
  type NativeCall,
  type NativeResult,
  type ChildCheckpoint,
} from "./native-history";

export interface NativeChildRecoveryConfig {
  /** Trusted local CLAUDE_CONFIG_DIR/projects directory. Not client input. */
  directory: string;
  /** Child tools requiring an answer. Unknown pending tools fail closed. */
  tools: string[];
  /** Execute the original tool, respecting its permissions. Must be idempotent by key across crashes. */
  execute(call: NativeCall, idempotencyKey: string): Promise<NativeResult>;
  /** Exclusive host lease covering all writers of this native session, including other processes. */
  acquire(sessionId: string): Promise<() => Promise<void>>;
  /** Recovery bridge deadline; must be below the hook timeout. Default 10 seconds. */
  timeoutMs?: number;
}
const MESSAGE =
  "Continue the original task using the recorded tool results. Do not repeat completed tools.";
const forever = () => new Promise<never>(() => {});
export class NativeChildRecovery {
  outcome?: RunFinishedOutcome;
  sessionId?: string;
  private child?: ChildProcess;
  private stopped = false;
  private killSent = false;
  private pausing = false;
  private bridge = false;
  private completed = false;
  private gateHeld = false;
  private resumeIssued = false;
  private timer?: ReturnType<typeof setTimeout>;
  private failure?: Error;
  private frontendNames = new Set<string>();
  private bridgeResults: Record<string, NativeResult> = {};
  constructor(
    private config: NativeChildRecoveryConfig,
    private automatic: Record<
      string,
      (call: NativeCall) => Promise<NativeResult>
    > = {},
    private prepare?: (
      options: Options,
    ) => Promise<{ options: Options; close(): Promise<void> }>,
  ) {
    if (
      (config.timeoutMs ?? 10000) <= 0 ||
      (config.timeoutMs ?? 10000) >= 50000
    )
      throw new Error("Recovery deadline must be between 0 and 50000 ms");
  }
  // Kill before SDK close/EOF can release hooks and let the parent continue.
  stop = () => {
    this.stopped = true;
    if (
      !this.killSent &&
      this.child?.pid &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      try {
        process.kill(-this.child.pid, "SIGKILL");
        this.killSent = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
    }
  };
  abort = (reason: string) => {
    this.failure = new Error(reason);
    this.stop();
  };
  private async waitForExit() {
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve, reject) => {
        child.once("exit", () => resolve());
        child.once("error", reject);
      });
  }
  private history() {
    return new NativeHistory(
      this.config.directory,
      this.sessionId!,
      this.config.tools,
    );
  }
  private interrupt(checkpoint: ChildCheckpoint) {
    this.outcome = {
      type: "interrupt",
      interrupts: checkpoint.pending.map((c) => ({
        id: c.id,
        toolCallId: c.id,
        reason: this.frontendNames.has(c.name) ? "tool_call" : "tool_approval",
        metadata: {
          source: "claude-sdk-native-child",
          sessionId: this.sessionId,
          childId: checkpoint.childId,
          parentToolUseId: checkpoint.parent.id,
          toolName: c.name,
          input: c.input,
        },
      })),
    };
  }
  private interruptPending(checkpoints: ChildCheckpoint[]): boolean {
    const interrupts = checkpoints.flatMap((cp) => {
      this.interrupt(cp);
      return this.outcome?.type === "interrupt" ? this.outcome.interrupts : [];
    });
    this.outcome = interrupts.length
      ? { type: "interrupt", interrupts }
      : undefined;
    return !!interrupts.length;
  }
  private async *answerAutomatic(
    checkpoints: ChildCheckpoint[],
  ): AsyncGenerator<SDKMessage> {
    for (const cp of checkpoints)
      for (const call of cp.pending) {
        const handler = this.automatic[call.name];
        if (!handler) continue;
        const result = await handler(call);
        await this.history().answer(cp, { [call.id]: result });
        yield {
          type: "user",
          session_id: this.sessionId!,
          parent_tool_use_id: cp.parent.id || null,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: call.id,
                content: result.content,
                is_error: !!result.is_error,
              },
            ],
          },
        };
      }
  }
  private async *answerCheckpoint(
    input: RunAgentInput,
    checkpoint: ChildCheckpoint,
    validateOnly = false,
  ): AsyncGenerator<SDKMessage> {
    const results: Record<string, NativeResult> = {};
    for (const call of checkpoint.calls) {
      const decisions = (input.resume ?? []).filter(
        (r) => r.interruptId === call.id,
      );
      const messages = input.messages.filter(
        (m) => m.role === "tool" && m.toolCallId === call.id,
      );
      if (decisions.length > 1 || messages.length > 1)
        throw new Error("Duplicate or conflicting tool answers");
      const response = decisions[0];
      const message = messages[0];
      const saved = await this.history().result(checkpoint, call.id);
      // A previous checkpoint may have persisted a result before a sibling
      // failed, without ever delivering it to AG-UI. Native history is the
      // source for replay; the client need not resubmit that tool's approval.
      if (
        !response &&
        !message &&
        !(saved && this.config.tools.includes(call.name))
      )
        continue;
      const frontend = this.frontendNames.has(call.name);
      if (response && message && !frontend && !saved)
        throw new Error("Duplicate or conflicting tool answers");
      let submitted: NativeResult | undefined;
      if (message?.role === "tool") {
        if (!saved && !this.frontendNames.has(call.name))
          throw new Error(
            "Client tool results may only answer configured frontend tools",
          );
        const marker = message.metadata?.["ag-ui:tool-result"];
        const error =
          message.error ??
          (marker && typeof marker === "object" && "error" in marker
            ? marker.error
            : undefined);
        submitted = {
          content:
            typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content),
          is_error: !!error,
        };
      }
      if (response) {
        if (this.automatic[call.name])
          throw new Error(
            "Internal state acknowledgements do not accept approval answers",
          );
        if (frontend) {
          if (!submitted)
            throw new Error("Frontend resume requires its actual tool result");
          const expected =
            response.status === "cancelled"
              ? { status: "cancelled" }
              : (response.payload ?? { status: "resolved" });
          // Registered frontend handlers return raw strings (including ""),
          // whereas useInterrupt serializes its payload as JSON. Both carry
          // actual results; validation must not rewrite either representation.
          const actualContent = saved?.content ?? submitted.content;
          let matches =
            typeof expected === "string" && actualContent === expected;
          if (!matches) {
            try {
              matches = isDeepStrictEqual(JSON.parse(actualContent), expected);
            } catch {
              // Non-JSON strings can only match their exact raw payload above.
            }
          }
          if (!matches)
            throw new Error(
              "Frontend resume payload conflicts with its tool result",
            );
          if (response.status === "cancelled") submitted.is_error = true;
        } else {
          if (
            response.status !== "cancelled" &&
            !["allow", "deny"].includes(response.payload?.behavior)
          )
            throw new Error("Child answer requires behavior allow or deny");
          if (response.payload?.updatedInput)
            throw new Error(
              "Native recovery answers cannot change the original tool input",
            );
        }
      }
      if (saved) {
        if (
          submitted &&
          (submitted.content !== saved.content ||
            !!submitted.is_error !== !!saved.is_error) &&
          !(
            message?.role === "tool" &&
            !!submitted.is_error === !!saved.is_error &&
            JSON.stringify(message.content) ===
              JSON.stringify(
                buildAguiToolMessage(
                  call.id,
                  saved.rawContent,
                  !!saved.is_error,
                ).content,
              )
          )
        )
          throw new Error(
            "Retransmitted frontend result differs from canonical history",
          );
        if (!validateOnly && !message && this.config.tools.includes(call.name))
          yield {
            type: "user",
            session_id: this.sessionId!,
            parent_tool_use_id: checkpoint.parent.id || null,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: call.id,
                  content: saved.rawContent,
                  is_error: !!saved.is_error,
                },
              ],
            },
          } as SDKMessage;
        continue;
      }
      if (!checkpoint.pending.some((c) => c.id === call.id))
        throw new Error("Tool is not awaiting an answer");
      if (validateOnly) continue;
      const result =
        submitted ??
        (response!.status !== "cancelled" &&
        response!.payload?.behavior === "allow"
          ? await this.config.execute(
              structuredClone(call),
              `${this.sessionId}:${checkpoint.childId}:${call.id}`,
            )
          : { content: "Tool execution denied by user", is_error: true });
      if (
        typeof result.content !== "string" ||
        (result.is_error !== undefined && typeof result.is_error !== "boolean")
      )
        throw new Error(
          "Recovery executor must return actual string content and optional is_error",
        );
      // Save each result before another handler can run or the process can yield.
      await this.history().answer(checkpoint, { [call.id]: result });
      results[call.id] = result;
    }
    if (Object.keys(results).length)
      yield {
        type: "user",
        session_id: this.sessionId!,
        parent_tool_use_id: checkpoint.parent.id || null,
        message: {
          role: "user",
          content: Object.entries(results).map(([id, r]) => ({
            type: "tool_result",
            tool_use_id: id,
            content: r.content,
            is_error: !!r.is_error,
          })),
        },
      };
  }
  async *run(
    input: RunAgentInput,
    options: Options,
    prompt: string | AsyncIterable<SDKUserMessage>,
  ): AsyncGenerator<SDKMessage> {
    if (
      process.platform === "win32" ||
      options.sessionStore ||
      options.spawnClaudeCodeProcess ||
      options.forkSession ||
      options.resumeSessionAt ||
      options.continue
    )
      throw new Error(
        "Native child recovery requires exclusive local POSIX sessions without custom transport/store, fork or rewind",
      );
    this.frontendNames = new Set(
      input.tools.map((t) => `mcp__ag_ui__${t.name}`),
    );
    this.config = {
      ...this.config,
      tools: [
        ...new Set([
          ...this.config.tools,
          ...this.frontendNames,
          ...Object.keys(this.automatic),
        ]),
      ],
    };
    this.sessionId = options.resume ?? options.sessionId;
    if (!this.sessionId)
      throw new Error(
        "Native child recovery requires an explicit sessionId for new sessions",
      );
    const release = await this.config.acquire(this.sessionId);
    const signal = options.abortController?.signal;
    const onAbort = () => this.abort("SDK run aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      if (this.failure) throw this.failure;
      let checkpoints = options.resume
        ? [
            await this.history().root(),
            ...(await this.history().children(true)),
          ]
        : [];
      const known = checkpoints.flatMap((c) => c.calls);
      if (
        (input.resume ?? []).some(
          (r) => !known.some((c) => c.id === r.interruptId),
        )
      )
        throw new Error("Answer does not match the original tool call");
      if (
        new Set((input.resume ?? []).map((r) => r.interruptId)).size !==
        (input.resume ?? []).length
      )
        throw new Error("Duplicate tool answers");
      // Per-checkpoint validation below covers the entire submission before effects.
      for (const message of input.messages.filter((m) => m.role === "tool")) {
        if (message.role !== "tool") continue;
        if (!known.some((c) => c.id === message.toolCallId))
          throw new Error(
            "Frontend result does not match original native history",
          );
        if (
          input.messages.filter(
            (m) => m.role === "tool" && m.toolCallId === message.toolCallId,
          ).length > 1
        )
          throw new Error("Duplicate or conflicting tool answers");
      }
      for (const cp of checkpoints)
        yield* this.answerCheckpoint(input, cp, true);
      yield* this.answerAutomatic(checkpoints);
      for (const cp of checkpoints) yield* this.answerCheckpoint(input, cp);
      while (options.resume) {
        checkpoints = [
          await this.history().root(),
          ...(await this.history().children()),
        ];
        if (this.interruptPending(checkpoints)) return;
        const children = checkpoints.filter((c) => c.childId);
        if (!children.length) break;
        const checkpoint = children.find((c) => !c.dependencies?.length);
        if (!checkpoint)
          throw new Error("Unresolved or cyclic native child dependencies");
        this.completed = false;
        this.gateHeld = false;
        this.resumeIssued = false;
        this.pausing = false;
        this.bridgeResults = {};
        if (checkpoint.final === undefined) {
          this.bridge = true;
          for await (const childMessage of this.execute(
            options,
            `Resume child ${checkpoint.childId} with SendMessage, message exactly: ${MESSAGE}`,
            checkpoint,
          )) {
            yield childMessage;
          }
          await this.history().settleBridge(checkpoint, this.bridgeResults);
          if (this.pausing) {
            yield* this.answerAutomatic([
              await this.history().root(),
              ...(await this.history().children()),
            ]);
            if (
              this.interruptPending([
                await this.history().root(),
                ...(await this.history().children()),
              ])
            )
              return;
          }
          if (!this.completed || !this.gateHeld)
            throw (
              this.failure ??
              new Error(
                "Child recovery did not complete while the parent was held",
              )
            );
          this.bridge = false;
        }
        const completed = (await this.history().children()).find(
          (c) => c.childId === checkpoint.childId,
        );
        await this.history().repair(checkpoint);
        if (!checkpoint.parentResolved)
          yield {
            type: "user",
            session_id: this.sessionId,
            parent_tool_use_id:
              children.find((c) => c.childId === checkpoint.ownerAgentId)
                ?.parent.id ?? null,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: checkpoint.parent.id,
                  content: completed!.final!,
                  is_error: false,
                },
              ],
            },
          };
        prompt =
          "Continue from the completed child results recorded in your history.";
      }
      if (options.resume) await this.history().assertRootReady();
      yield* this.execute(options, prompt);
      if (this.pausing) {
        yield* this.answerAutomatic([
          await this.history().root(),
          ...(await this.history().children()),
        ]);
        if (
          !this.interruptPending([
            await this.history().root(),
            ...(await this.history().children()),
          ])
        )
          throw new Error("Approval was not durably recorded");
      }
    } finally {
      this.stop();
      if (this.timer) clearTimeout(this.timer);
      signal?.removeEventListener("abort", onAbort);
      await release();
    }
  }
  private async *execute(
    options: Options,
    prompt: string | AsyncIterable<SDKUserMessage>,
    checkpoint?: ChildCheckpoint,
  ): AsyncGenerator<SDKMessage> {
    const prepared = await this.prepare?.(options);
    try {
      yield* this.executeWorker(
        prepared?.options ?? options,
        prompt,
        checkpoint,
      );
    } finally {
      await prepared?.close();
    }
  }
  private async *executeWorker(
    options: Options,
    prompt: string | AsyncIterable<SDKUserMessage>,
    checkpoint?: ChildCheckpoint,
  ): AsyncGenerator<SDKMessage> {
    if (this.failure) throw this.failure;
    this.stopped = false;
    this.killSent = false;
    this.child = undefined;
    const pre: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      if (this.bridge && !input.agent_id) {
        const data = input.tool_input as Record<string, unknown>;
        if (
          !this.resumeIssued &&
          input.tool_name === "SendMessage" &&
          data.to === checkpoint!.childId &&
          data.message === MESSAGE
        ) {
          this.resumeIssued = true;
          return {};
        }
        this.bridgeResults[input.tool_use_id] = {
          content: "Parent tool was not executed: held during child recovery",
          is_error: true,
        };
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "Parent is held during child recovery",
          },
        };
      }
      if (
        this.config.tools.includes(input.tool_name) &&
        !this.automatic[input.tool_name]
      ) {
        this.pausing = true;
        // The tool call is already in native history before permission execution.
        // Do not return a denial/defer: leave the original call unanswered.
        const deadline = Date.now() + 4000;
        while (true) {
          try {
            const saved = input.agent_id
              ? (await this.history().children()).find(
                  (c) => c.childId === input.agent_id,
                )
              : await this.history().root();
            if (saved?.pending.some((c) => c.id === input.tool_use_id)) {
              const children = await this.history().children();
              if (
                this.bridge ||
                children.every(
                  (c) =>
                    c.pending.length ||
                    c.dependencies?.length ||
                    c.final !== undefined,
                )
              )
                break;
            }
          } catch (error) {
            if (Date.now() >= deadline) {
              this.failure =
                error instanceof Error ? error : new Error(String(error));
              break;
            }
          }
          if (Date.now() >= deadline) {
            this.failure = new Error(
              "Native approval was not flushed before recovery deadline",
            );
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        this.stop();
        return forever();
      }
      return {};
    };
    const post: HookCallback = async (input) => {
      if (
        this.bridge &&
        input.hook_event_name === "PostToolUse" &&
        !input.agent_id &&
        input.tool_name === "SendMessage"
      ) {
        this.bridgeResults[input.tool_use_id] = {
          content: JSON.stringify(input.tool_response),
          is_error: false,
        };
        this.gateHeld = true;
        if (this.completed) this.stop();
        return forever();
      }
      return {};
    };
    const source = prompt;
    const stream =
      typeof source === "string"
        ? (async function* () {
            yield {
              type: "user" as const,
              session_id: "",
              parent_tool_use_id: null,
              message: { role: "user" as const, content: source },
            };
            await forever();
          })()
        : source;
    const run = query({
      prompt: stream,
      options: {
        ...options,
        sessionId: options.resume ? undefined : options.sessionId,
        extraArgs: { ...options.extraArgs, "await-initialize": null },
        hooks: {
          ...options.hooks,
          PreToolUse: [
            ...(options.hooks?.PreToolUse ?? []),
            { hooks: [pre], timeout: 60 },
          ],
          PostToolUse: [
            ...(options.hooks?.PostToolUse ?? []),
            { hooks: [post], timeout: 60 },
          ],
        },
        spawnClaudeCodeProcess: (s) => {
          const child = spawn(s.command, s.args, {
            cwd: s.cwd,
            env: s.env,
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
          this.child = child;
          child.stderr.on("data", (chunk) => options.stderr?.(String(chunk)));
          if (this.stopped) this.stop();
          return child;
        },
      },
    });
    if (this.bridge)
      this.timer = setTimeout(() => {
        this.failure = new Error(
          "Child recovery timed out; parent remains unresolved",
        );
        this.stop();
      }, this.config.timeoutMs ?? 10000);
    let finishedNormally = false;
    try {
      for await (const message of run) {
        if (
          this.bridge &&
          message.type === "system" &&
          message.subtype === "task_notification" &&
          message.task_id === checkpoint!.childId &&
          message.status === "completed"
        ) {
          while (
            !this.stopped &&
            !(await this.history().completed(checkpoint!))
          )
            await new Promise((resolve) => setTimeout(resolve, 25));
          this.completed = !this.stopped;
          if (this.gateHeld) this.stop();
        }
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          message.claude_code_version !== "2.1.306"
        )
          throw new Error("Native child recovery requires CLI 2.1.306");
        if (
          !this.bridge ||
          ("parent_tool_use_id" in message && message.parent_tool_use_id)
        )
          yield message;
        if (!this.bridge && message.type === "result") {
          if (
            (await this.history().children()).some((c) => c.final === undefined)
          )
            continue;
          finishedNormally = true;
          break;
        }
      }
    } catch (e) {
      if (!this.stopped) throw e;
    } finally {
      if (finishedNormally) {
        run.close();
        await this.waitForExit();
      } else {
        this.stop();
        await this.waitForExit();
        run.close();
      }
      if (this.timer) clearTimeout(this.timer);
    }
    if (this.failure) throw this.failure;
  }
}
