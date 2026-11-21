import { readFileSync } from "node:fs";
import {
  EventType,
  enforceEvents,
  transformChunks,
  verifyEvents,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import { MastraAgent, type MastraAgentConfig } from "../mastra";
import {
  FakeLocalAgent,
  FakeMemory,
  FakeRemoteAgent,
  makeInput,
} from "./helpers";

/** A first turn: one user message. */
export const FIRST_TURN = makeInput({
  messages: [{ id: "user-1", role: "user", content: "Research it." }],
});

/**
 * Real `fullStream` captures of `@mastra/core` 1.74.0 supervisors delegating
 * to sub-agents (`agents: { … }`), each agent driven by
 * `MastraLanguageModelV2Mock`. Only bulky bodies (requests, responses,
 * message lists, provider metadata) are trimmed, and the one stack trace is
 * replaced by a neutral one; chunk order, ids and payload shapes are as
 * Mastra streamed them.
 */
export type CaptureName =
  | "a-single"
  | "b-parallel"
  | "c-nested"
  | "d-subtool-throws"
  | "e-approval"
  | "e-approval-resume"
  | "e2-suspend"
  | "e2-suspend-resume"
  | "f-submodel-error"
  | "f2-submodel-throws"
  | "g-subagent-tripwire"
  | "h-abort"
  | "i-plain-tool-writer"
  | "j-subagent-data-chunks"
  | "k-workflow-tool"
  | "m-delegation-plus-client-tool";

export function capture(name: CaptureName): any[] {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/mastra-subagents/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

/** Whether a chunk is (or wraps, at any depth) a delegated sub-agent's chunk. */
export function isDelegatedChunk(chunk: any): boolean {
  return (
    chunk?.type === "tool-output" &&
    typeof chunk.payload?.toolName === "string" &&
    chunk.payload.toolName.startsWith("agent-")
  );
}

/** A capture with every occurrence of each `from` string replaced. */
export function renamed(chunks: any[], renames: Record<string, string>): any[] {
  let json = JSON.stringify(chunks);
  for (const [from, to] of Object.entries(renames)) {
    json = json.split(JSON.stringify(from)).join(JSON.stringify(to));
  }
  return JSON.parse(json);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * The events as JSON with every UUID renamed by order of first appearance,
 * so two runs that mint different random ids compare equal when they agree
 * on everything else.
 */
export function canonical(events: BaseEvent[]): string {
  const ids = new Map<string, string>();
  return JSON.stringify(events).replace(UUID, (uuid) => {
    if (!ids.has(uuid)) ids.set(uuid, `uuid-${ids.size}`);
    return ids.get(uuid)!;
  });
}

/**
 * A local agent whose stream yields `chunks` up to `cutAt`, then waits for
 * `release()` before yielding the rest: a run stopped there is provably
 * mid-delegation.
 */
export function gatedLocal(chunks: any[], cutAt: number, options: Options) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fake = {
    memory: new FakeMemory(),
    async getMemory() {
      return this.memory;
    },
    async stream() {
      return {
        fullStream: (async function* () {
          for (const chunk of chunks.slice(0, cutAt)) yield chunk;
          await gate;
          for (const chunk of chunks.slice(cutAt)) yield chunk;
        })(),
      };
    },
  };
  return {
    release,
    agent: new MastraAgent({
      agentId: "supervisor",
      agent: fake as any,
      resourceId: "resource-1",
      ...options,
    }),
  };
}

/** The remote counterpart of gatedLocal. */
export function gatedRemote(chunks: any[], cutAt: number, options: Options) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fake = {
    async stream() {
      return {
        processDataStream: async ({
          onChunk,
        }: {
          onChunk: (chunk: any) => Promise<void>;
        }) => {
          for (const chunk of chunks.slice(0, cutAt)) await onChunk(chunk);
          await gate;
          for (const chunk of chunks.slice(cutAt)) await onChunk(chunk);
        },
      };
    },
  };
  return {
    release,
    agent: new MastraAgent({
      agentId: "supervisor",
      agent: fake as any,
      resourceId: "resource-1",
      ...options,
    }),
  };
}

/**
 * Runs `agent` until an event matches `stopAt`, stops it with abortRun(),
 * and resolves with every event the run emitted.
 */
export function runAndStop(
  agent: MastraAgent,
  input: RunAgentInput,
  stopAt: (event: any) => boolean,
): Promise<BaseEvent[]> {
  const events: BaseEvent[] = [];
  return new Promise((resolve, reject) => {
    let stopped = false;
    agent.run(input).subscribe({
      next: (event) => {
        events.push(event);
        if (!stopped && stopAt(event)) {
          stopped = true;
          queueMicrotask(() => agent.abortRun());
        }
      },
      error: reject,
      complete: () => resolve(events),
    });
  });
}

/** The index of the first chunk matching `predicate` (throws when none). */
export function chunkIndex(
  chunks: any[],
  predicate: (chunk: any) => boolean,
): number {
  const index = chunks.findIndex(predicate);
  if (index < 0) throw new Error("no matching chunk");
  return index;
}

/**
 * Pipes a run's events through the AG-UI client's own stages, in the order
 * `runAgent` applies them (enforce, expand chunks, verify), and resolves with
 * the expanded events. Rejects on any protocol violation, which CopilotKit's
 * runtime would turn into a RUN_ERROR.
 */
export function verified(events: BaseEvent[]): Promise<BaseEvent[]> {
  return lastValueFrom(
    from(events).pipe(
      enforceEvents(),
      transformChunks(),
      verifyEvents(),
      toArray(),
    ),
  );
}

type Options = Partial<
  Pick<
    MastraAgentConfig,
    | "subagentVisibility"
    | "subagentToolResults"
    | "streamServerToolCalls"
    | "useProcessedFinalText"
  >
>;

export function localAgent(
  chunks: any[],
  options: Options = {},
  fake: Partial<FakeLocalAgent> & Record<string, unknown> = {},
) {
  const agent = Object.assign(
    new FakeLocalAgent({ streamChunks: chunks }),
    fake,
  );
  return {
    fake: agent,
    agent: new MastraAgent({
      agentId: "supervisor",
      agent: agent as any,
      resourceId: "resource-1",
      ...options,
    }),
  };
}

export function remoteAgent(chunks: any[], options: Options = {}) {
  const fake = new FakeRemoteAgent({ streamChunks: chunks });
  return {
    fake,
    agent: new MastraAgent({
      agentId: "supervisor",
      agent: fake as any,
      resourceId: "resource-1",
      ...options,
    }),
  };
}

export const attributed: Options = { subagentVisibility: "attributed" };

/** Both bridge paths share the chunk processor; every suite runs on each. */
export const PATHS = [
  ["local", localAgent],
  ["remote", remoteAgent],
] as const;

/**
 * One line per event: its type, the entity it names, and its attribution in
 * brackets. Lets a test state a whole stream's shape at once.
 */
export function outline(events: BaseEvent[]): string[] {
  return events.map((event) => {
    const e = event as Record<string, any>;
    const entity =
      e.type === EventType.SUBAGENT_STARTED
        ? `${e.subagentRunId} ${e.name}${e.parentSubagentRunId ? ` <${e.parentSubagentRunId}` : ""}`
        : e.type === EventType.SUBAGENT_FINISHED ||
            e.type === EventType.SUBAGENT_ERROR
          ? `${e.subagentRunId}${e.code ? ` ${e.code}` : ""}${e.outcome ? ` ${e.outcome.type}` : ""}`
          : (e.toolCallId ?? e.messageId ?? "");
    const tag =
      e.subagentRunId !== undefined &&
      e.type !== EventType.SUBAGENT_STARTED &&
      e.type !== EventType.SUBAGENT_FINISHED &&
      e.type !== EventType.SUBAGENT_ERROR
        ? ` [${e.subagentRunId}]`
        : "";
    return `${e.type}${entity ? ` ${entity}` : ""}${tag}`.trim();
  });
}

/**
 * outline() with every id the bridge minted at random shown as `<id>`, so a
 * whole stream can be stated exactly. Ids the capture carries are kept.
 */
export function stableOutline(events: BaseEvent[], chunks: any[]): string[] {
  const known = JSON.stringify(chunks);
  return outline(events).map((line) =>
    line.replace(UUID, (uuid) => (known.includes(uuid) ? uuid : "<id>")),
  );
}

/** The events of one type, typed loosely for assertions. */
export function ofType(events: BaseEvent[], type: EventType): any[] {
  return events.filter((event) => event.type === type);
}

/** Index of the first event matching `predicate`; fails the test when none. */
export function indexOf(
  events: BaseEvent[],
  predicate: (event: any) => boolean,
): number {
  const index = events.findIndex(predicate);
  if (index < 0) throw new Error("no matching event");
  return index;
}
