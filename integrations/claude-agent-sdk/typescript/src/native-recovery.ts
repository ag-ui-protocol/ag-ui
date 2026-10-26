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
  private bridgeResults: Record<string, NativeResult> = {};
  constructor(private config: NativeChildRecoveryConfig) {
    if (!config.tools.length)
      throw new Error("Native child recovery requires explicit tools");
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
        reason: "tool_approval",
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
      let checkpoint = options.resume
        ? await this.history().inspect()
        : undefined;
      if (checkpoint) {
        const responses = input.resume ?? [];
        if (
          responses.some(
            (r) => !checkpoint!.calls.some((c) => c.id === r.interruptId),
          )
        )
          throw new Error("Answer does not match the original child call");
        if (
          new Set(responses.map((r) => r.interruptId)).size !== responses.length
        )
          throw new Error("Duplicate child answers");
        // Validate the complete request before executing any tool.
        for (const response of responses) {
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
        const results: Record<string, NativeResult> = {};
        for (const response of responses) {
          const call = checkpoint.pending.find(
            (c) => c.id === response.interruptId,
          );
          if (!call) continue;
          const allow =
            response.status !== "cancelled" &&
            response.payload?.behavior === "allow";
          const result = allow
            ? await this.config.execute(
                structuredClone(call),
                `${this.sessionId}:${checkpoint.childId}:${call.id}`,
              )
            : { content: "Tool execution denied by user", is_error: true };
          if (
            typeof result.content !== "string" ||
            (result.is_error !== undefined &&
              typeof result.is_error !== "boolean")
          )
            throw new Error(
              "Recovery executor must return actual string content and optional is_error",
            );
          results[call.id] = result;
        }
        if (Object.keys(results).length) {
          await this.history().answer(checkpoint, results);
          yield {
            type: "user",
            session_id: this.sessionId,
            parent_tool_use_id: checkpoint.parent.id,
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
        checkpoint = await this.history().inspect();
        if (checkpoint!.pending.length) {
          this.interrupt(checkpoint!);
          return;
        }
        if (checkpoint!.final === undefined) {
          this.bridge = true;
          for await (const _ of this.execute(
            options,
            `Resume child ${checkpoint!.childId} with SendMessage, message exactly: ${MESSAGE}`,
            checkpoint,
          )) {
            /* bridge parent output must not escape */
          }
          await this.history().settleBridge(checkpoint!, this.bridgeResults);
          if (this.pausing) {
            const next = await this.history().inspect();
            if (next?.pending.length) {
              this.interrupt(next);
              return;
            }
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
        const completed = await this.history().inspect();
        await this.history().repair(checkpoint!);
        yield {
          type: "user",
          session_id: this.sessionId,
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: checkpoint!.parent.id,
                content: completed!.final!,
                is_error: false,
              },
            ],
          },
        };
        prompt =
          "Continue from the completed child result recorded in your history.";
      } else if (input.resume?.length)
        throw new Error("No unanswered native child call matches this answer");
      yield* this.execute(options, prompt);
      if (this.pausing) {
        const pending = await this.history().inspect();
        if (!pending?.pending.length)
          throw new Error("Child approval was not durably recorded");
        this.interrupt(pending);
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
    if (this.failure) throw this.failure;
    this.stopped = false;
    this.killSent = false;
    this.child = undefined;
    const pre: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      if (
        input.tool_name === "Agent" &&
        (input.agent_id ||
          (input.tool_input as Record<string, unknown>).run_in_background !==
            false)
      )
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "Native recovery requires one direct foreground child. Set run_in_background to false.",
          },
        };
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
      if (input.agent_id && this.config.tools.includes(input.tool_name)) {
        this.pausing = true;
        // The tool call is already in native history before permission execution.
        // Do not return a denial/defer: leave the original call unanswered.
        const deadline = Date.now() + 4000;
        while (true) {
          try {
            const saved = await this.history().inspect();
            if (saved?.pending.some((c) => c.id === input.tool_use_id)) break;
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
        if (!this.bridge) yield message;
        if (!this.bridge && message.type === "result") {
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
