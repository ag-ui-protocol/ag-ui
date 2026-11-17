import { randomUUID, type BaseEvent, type Message } from "@ag-ui/client";
import { streamToAGUI } from "./run";
import type { StreamTextLike } from "./translate";

/**
 * Streams an AI SDK result you created yourself as an AG-UI run.
 *
 * @deprecated Use `withAGUI` (a Durable Object agent) or `handleAGUIRequest`
 * (a plain Worker): they also convert the client's messages and tools, carry
 * context and shared state, and resume tool approvals. For a result you
 * already have, `streamToAGUI(input, result)` is the direct replacement.
 */
export class AgentsToAGUIAdapter {
  async *adaptStreamToAGUI(
    stream: StreamTextLike,
    threadId: string = randomUUID(),
    runId: string = randomUUID(),
    inputMessages: Message[] = [],
    parentRunId?: string,
    state?: Record<string, unknown>,
    forwardedProps?: Record<string, unknown>,
  ): AsyncGenerator<BaseEvent> {
    yield* streamToAGUI(
      {
        threadId,
        runId,
        messages: inputMessages,
        state: state ?? {},
        tools: [],
        context: [],
        forwardedProps: forwardedProps ?? {},
        ...(parentRunId && { parentRunId }),
      },
      stream,
    );
  }
}
