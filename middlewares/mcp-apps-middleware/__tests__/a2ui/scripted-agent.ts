import {
  AbstractAgent,
  type ActivitySnapshotEvent,
  type BaseEvent,
  EventType,
  type Middleware,
  randomUUID,
  type RunAgentInput,
  type ToolCallResultEvent,
} from "@ag-ui/client";
import { type Observable, of } from "rxjs";

export interface ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ScriptedRun {
  events: BaseEvent[];
  agentInputs: RunAgentInput[];
}

export class ScriptedAgent extends AbstractAgent {
  readonly inputs: RunAgentInput[] = [];
  private runCount = 0;

  constructor(private readonly toolCalls: ScriptedToolCall[]) {
    super();
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    this.inputs.push(input);
    this.runCount += 1;
    const body =
      this.runCount === 1
        ? this.toolCalls.flatMap(toolCallEvents)
        : textEvents("Done.");

    return of(
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent,
      ...body,
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent,
    );
  }
}

export async function runWithMiddlewares(
  middlewares: Middleware[],
  toolCalls: ScriptedToolCall[],
): Promise<BaseEvent[]> {
  const run = await runScripted(middlewares, toolCalls, {});
  return run.events;
}

export async function runScripted(
  middlewares: Middleware[],
  toolCalls: ScriptedToolCall[],
  forwardedProps: Record<string, unknown>,
): Promise<ScriptedRun> {
  const agent = new ScriptedAgent(toolCalls);
  agent.use(...middlewares);
  const events: BaseEvent[] = [];
  await agent.runAgent(
    { forwardedProps },
    {
      onEvent: (params) => {
        events.push(params.event);
      },
    },
  );
  return { events, agentInputs: agent.inputs };
}

export function activitySnapshots(
  events: BaseEvent[],
): ActivitySnapshotEvent[] {
  return events.filter(
    (event) => event.type === EventType.ACTIVITY_SNAPSHOT,
  ) as ActivitySnapshotEvent[];
}

export function toolCallResults(events: BaseEvent[]): ToolCallResultEvent[] {
  return events.filter(
    (event) => event.type === EventType.TOOL_CALL_RESULT,
  ) as ToolCallResultEvent[];
}

function toolCallEvents(toolCall: ScriptedToolCall): BaseEvent[] {
  const toolCallId = randomUUID();
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: toolCall.name,
    } as BaseEvent,
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify(toolCall.args),
    } as BaseEvent,
    { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent,
  ];
}

function textEvents(text: string): BaseEvent[] {
  const messageId = randomUUID();
  return [
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
    } as BaseEvent,
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: text,
    } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent,
  ];
}
