import { BridgeError } from "./errors";
import { randomBytes, randomUUID } from "node:crypto";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import type { Event, Message, Part } from "@opencode-ai/sdk/v2";
import { EventMapper } from "./event-mapper";
import {
  answerInterrupt,
  toInterrupt,
  type PendingInterrupt,
} from "./permissions";
import {
  sessionKey,
  type SessionRecord,
  type SessionStore,
} from "./session-store";
import type { OpenCodeTransport } from "./transport";

export interface RunContext {
  owner: string;
  directory: string;
  signal?: AbortSignal;
}
export interface BridgeOptions {
  transport: OpenCodeTransport;
  store: SessionStore;
  directory: string;
  timeoutMs?: number;
  interruptTtlMs?: number;
}
/** Each instance is bound to a trusted project directory and a private OpenCode server. */
export class OpenCodeBridge {
  constructor(private readonly options: BridgeOptions) {}
  async run(
    input: RunAgentInput,
    context: RunContext,
    emit: (event: BaseEvent) => void,
  ): Promise<void> {
    const { transport, store } = this.options;
    const controller = new AbortController();
    const signal = controller.signal;
    const cancel = () =>
      controller.abort(context.signal?.reason ?? new Error("Cancelled"));
    context.signal?.addEventListener("abort", cancel, { once: true });
    if (context.signal?.aborted) cancel();
    const timeout = setTimeout(
      () => controller.abort(new Error("Run timed out")),
      this.options.timeoutMs ?? 120_000,
    );
    let release: (() => Promise<void>) | undefined;
    let record: SessionRecord | undefined;
    let mapper: EventMapper | undefined;
    let key: string | undefined;
    let ownsActive = false;
    let finished = false;
    emit({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    });
    const finish = (outcome: Record<string, unknown>) => {
      finished = true;
      emit({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        outcome,
      });
    };
    try {
      signal.throwIfAborted();
      if (context.directory !== this.options.directory)
        throw new BridgeError("Project directory is not authorized");
      if (input.tools?.length)
        throw new BridgeError("Client-defined tools are not supported");
      if (
        input.context?.length ||
        (input.state && Object.keys(input.state).length)
      )
        throw new BridgeError("Shared state and context are not supported");
      key = sessionKey(context.owner, input.threadId, context.directory);
      release = await store.acquire(key);
      record = await store.read(key);
      const resume = input.resume?.length ? input.resume : undefined;
      if (resume && (!record?.pending || resume.length !== 1))
        throw new BridgeError(
          "Exactly one stored interrupt is required to resume",
        );
      if (
        resume &&
        input.messages.some(
          (m) => m.role === "user" && !record!.consumed.includes(m.id),
        )
      )
        throw new BridgeError(
          "Do not submit a new user turn with an interrupt answer",
        );
      if (record?.active && !record.pending)
        throw new BridgeError(
          "Previous run requires recovery; streaming resume is unsupported",
        );
      if (record?.pending && !resume)
        throw new BridgeError(
          "Answer the pending interrupt before sending another turn",
        );
      let user: { id: string; content: string } | undefined;
      if (!resume) {
        const messages = input.messages.filter((m) => m.role === "user");
        const newMessages = messages.filter(
          (m) => !record?.consumed.includes(m.id),
        );
        if (newMessages.length !== 1)
          throw new BridgeError(
            "Supply exactly one new user message; history import is unsupported",
          );
        const candidate = newMessages[0];
        if (typeof candidate.content !== "string" || !candidate.content.trim())
          throw new BridgeError("Only nonempty user text is supported");
        if (
          input.messages.some(
            (m) =>
              m.role !== "user" &&
              m.role !== "assistant" &&
              m.role !== "tool" &&
              m.role !== "system" &&
              m.role !== "developer",
          )
        )
          throw new BridgeError("Unsupported message role");
        user = { id: candidate.id, content: candidate.content };
      }
      const stream = await transport.subscribe(signal);
      if (!record) {
        record = { sessionID: await transport.create(signal), consumed: [] };
        await store.write(key, record);
      }
      mapper = new EventMapper(
        emit,
        input.messages,
        resume ? record.mapper : undefined,
      );
      const known = new Set<string>();
      const parts = new Map<string, Part>();
      const seen = new Set<string>();
      const buffered: Event[] = [];
      const correlate = (info: Message) => {
        if (
          info.sessionID !== record!.sessionID ||
          info.role !== "assistant" ||
          info.parentID !== record!.active?.messageID
        )
          return false;
        known.add(info.id);
        return true;
      };
      const synchronize = async () => {
        const messages = await transport.messages(record!.sessionID, signal);
        for (const message of messages)
          if (correlate(message.info)) {
            for (const part of message.parts) {
              parts.set(part.id, part);
              mapper!.part(part);
            }
          }
        return messages;
      };
      if (resume) {
        await synchronize();
        // Persist the uncertainty BEFORE sending a reply, so a crash never retries an approval.
        const pending = record.pending!;
        if (Date.parse(pending.expiresAt) <= Date.now()) {
          ownsActive = true;
          await transport.abort(record.sessionID);
          delete record.active;
          delete record.pending;
          delete record.mapper;
          await store.write(key, record);
          throw new BridgeError("Interrupt expired; OpenCode run aborted");
        }
        // Validation errors keep the interrupt answerable. After sending a reply,
        // failures abort the owned turn; a failed abort retains the recovery marker.
        const denied = await answerInterrupt(
          transport,
          pending,
          resume[0],
          record.sessionID,
          signal,
          async () => {
            delete record!.pending;
            await store.write(key!, record!);
            ownsActive = true;
          },
        );
        if (denied) {
          await transport.abort(record.sessionID);
          await synchronize();
          mapper.close(true);
          delete record.active;
          delete record.mapper;
          await store.write(key, record);
          ownsActive = false;
          finish({ type: "cancelled" });
          return;
        }
      } else {
        record.active = {
          messageID: `msg_${Date.now().toString(16)}${randomBytes(12).toString("hex")}`,
          userID: user!.id,
        };
        record.consumed.push(user!.id);
        await store.write(key, record);
        ownsActive = true;
        const instructions = input.messages
          .filter((m) => m.role === "system" || m.role === "developer")
          .map((m) => m.content)
          .join("\n\n");
        await transport.prompt(
          record.sessionID,
          record.active.messageID,
          user!.content,
          signal,
          instructions || undefined,
        );
      }
      const apply = (event: Event) => {
        if (event.type === "message.part.updated") {
          const part = event.properties.part;
          if (known.has(part.messageID)) {
            parts.set(part.id, part);
            mapper!.part(part);
          } else buffered.push(event);
        } else if (
          event.type === "message.part.delta" &&
          event.properties.field === "text"
        ) {
          const p = event.properties;
          if (!known.has(p.messageID)) {
            buffered.push(event);
            return;
          }
          const part = parts.get(p.partID);
          if (part?.type === "text") {
            const updated = { ...part, text: part.text + p.delta };
            parts.set(part.id, updated);
            mapper!.part(updated);
          }
        }
      };
      for await (const event of stream) {
        signal.throwIfAborted();
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        const properties = event.properties;
        if (
          !("sessionID" in properties) ||
          properties.sessionID !== record.sessionID
        )
          continue;
        if (
          event.type === "message.updated" &&
          correlate(event.properties.info)
        ) {
          const waiting = buffered.splice(0);
          for (const pending of waiting) apply(pending);
          const info = event.properties.info;
          if (info.role === "assistant" && info.error)
            throw new BridgeError("OpenCode assistant failed");
          if (
            info.role === "assistant" &&
            info.time.completed &&
            info.finish &&
            info.finish !== "tool-calls" &&
            info.finish !== "unknown"
          ) {
            await synchronize();
            mapper.close();
            delete record.active;
            delete record.mapper;
            await store.write(key, record);
            ownsActive = false;
            finish({ type: "success" });
            return;
          }
        }
        apply(event);
        if (event.type === "session.error")
          throw new BridgeError("OpenCode session failed");
        if (
          event.type === "permission.asked" ||
          event.type === "question.asked"
        ) {
          const request = event.properties;
          if (request.tool && !known.has(request.tool.messageID)) continue;
          const pending: PendingInterrupt =
            event.type === "permission.asked"
              ? {
                  kind: "permission",
                  request: event.properties,
                  id: randomUUID(),
                  expiresAt: new Date(
                    Date.now() + (this.options.interruptTtlMs ?? 300_000),
                  ).toISOString(),
                }
              : {
                  kind: "question",
                  request: event.properties,
                  id: randomUUID(),
                  expiresAt: new Date(
                    Date.now() + (this.options.interruptTtlMs ?? 300_000),
                  ).toISOString(),
                };
          mapper.close();
          record.pending = pending;
          record.mapper = mapper.state;
          await store.write(key, record);
          ownsActive = false;
          finish({ type: "interrupt", interrupts: [toInterrupt(pending)] });
          return;
        }
      }
      throw new BridgeError(
        "OpenCode event stream ended; streaming resume is unsupported",
      );
    } catch (error) {
      if (ownsActive && record && key) {
        try {
          await transport.abort(record.sessionID);
          delete record.active;
          delete record.pending;
          delete record.mapper;
          await store.write(key, record);
        } catch {
          /* Leave the durable active marker: explicit recovery is required. */
        }
      }
      mapper?.close(ownsActive);
      if (!finished) {
        // Do not expose SDK errors, provider credentials, prompts, or paths.
        const safe =
          error instanceof BridgeError ? error.message : "OpenCode run failed";
        if (context.signal?.aborted) finish({ type: "cancelled" });
        else
          emit({
            type: EventType.RUN_ERROR,
            message: safe,
            code: signal.aborted ? "TIMEOUT" : "OPENCODE_ERROR",
          });
      }
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", cancel);
      controller.abort();
      await release?.();
    }
  }
}
