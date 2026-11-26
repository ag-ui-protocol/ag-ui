import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import {
  MockAgent,
  createRunStartedEvent,
  createRunFinishedEvent,
  createToolCallStartEvent,
  createToolCallArgsEvent,
  createToolCallEndEvent,
} from "./test-utils";

/** Reuse MockAgent's event playback while allowing a different model turn per run. */
export class SequenceAgent extends MockAgent {
  constructor(
    private readonly eventsForRun: (
      input: RunAgentInput,
      turn: number,
    ) => BaseEvent[],
  ) {
    super();
  }
  override run(input: RunAgentInput) {
    this.setEvents(this.eventsForRun(input, this.runCalls.length));
    return super.run(input);
  }
}

export function toolTurn(
  input: RunAgentInput,
  name: string,
  id: string,
  args = "{}",
): BaseEvent[] {
  return [
    createRunStartedEvent(input.runId, input.threadId),
    createToolCallStartEvent(id, name),
    createToolCallArgsEvent(id, args),
    createToolCallEndEvent(id),
    createRunFinishedEvent(input.runId, input.threadId),
  ];
}
