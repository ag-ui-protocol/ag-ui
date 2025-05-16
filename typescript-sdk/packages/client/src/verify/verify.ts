import { BaseEvent, EventType, AGUIError } from "@ag-ui/core";
import { Observable, throwError, of } from "rxjs";
import { mergeMap } from "rxjs/operators";

export const verifyEvents =
  (debug: boolean) =>
  (source$: Observable<BaseEvent>): Observable<BaseEvent> => {
    // Declare variables in closure to maintain state across events
    let activeMessageId: string | undefined;
    let activeToolCallId: string | undefined;
    let runFinished = false;
    let runError = false; // New flag to track if RUN_ERROR has been sent
    // New flags to track first/last event requirements
    let firstEventReceived = false;
    // Track active steps
    let activeSteps = new Map<string, boolean>(); // Map of step name -> active status

    return source$.pipe(
      // Process each event through our state machine
      mergeMap((event) => {
        const eventType = event.type;

        if (debug) {
          console.debug("[VERIFY]:", JSON.stringify(event));
        }

        // Check if run has errored
        if (runError) {
          return throwError(
            () =>
              new AGUIError(
                `Cannot send event type '${eventType}': The run has already errored with 'RUN_ERROR'. No further events can be sent.`,
              ),
          );
        }

        // Check if run has already finished
        if (runFinished && eventType !== EventType.RUN_ERROR) {
          return throwError(
            () =>
              new AGUIError(
                `Cannot send event type '${eventType}': The run has already finished with 'RUN_FINISHED'. Start a new run with 'RUN_STARTED'.`,
              ),
          );
        }

        // Forbid lifecycle events and tool events inside a text message
        if (activeMessageId !== undefined) {
          // Define allowed event types inside a text message
          const allowedEventTypes = [
            EventType.TEXT_MESSAGE_CONTENT,
            EventType.TEXT_MESSAGE_END,
            EventType.RAW,
          ];

          // If the event type is not in the allowed list, throw an error
          if (!allowedEventTypes.includes(eventType)) {
            return throwError(
              () =>
                new AGUIError(
                  `Cannot send event type '${eventType}' after 'TEXT_MESSAGE_START': Send 'TEXT_MESSAGE_END' first.`,
                ),
            );
          }
        }

        // Forbid lifecycle events and text message events inside a tool call
        if (activeToolCallId !== undefined) {
          // Define allowed event types inside a tool call
          const allowedEventTypes = [
            EventType.TOOL_CALL_ARGS,
            EventType.TOOL_CALL_END,
            EventType.RAW,
          ];

          // If the event type is not in the allowed list, throw an error
          if (!allowedEventTypes.includes(eventType)) {
            // Special handling for nested tool calls for better error message
            if (eventType === EventType.TOOL_CALL_START) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TOOL_CALL_START' event: A tool call is already in progress. Complete it with 'TOOL_CALL_END' first.`,
                  ),
              );
            }

            return throwError(
              () =>
                new AGUIError(
                  `Cannot send event type '${eventType}' after 'TOOL_CALL_START': Send 'TOOL_CALL_END' first.`,
                ),
            );
          }
        }

        // Handle first event requirement and prevent multiple RUN_STARTED
        if (!firstEventReceived) {
          firstEventReceived = true;
          if (eventType !== EventType.RUN_STARTED && eventType !== EventType.RUN_ERROR) {
            return throwError(() => new AGUIError(`First event must be 'RUN_STARTED'`));
          }
        } else if (eventType === EventType.RUN_STARTED) {
          // Prevent multiple RUN_STARTED events
          return throwError(
            () =>
              new AGUIError(
                `Cannot send multiple 'RUN_STARTED' events: A 'RUN_STARTED' event was already sent. Each run must have exactly one 'RUN_STARTED' event at the beginning.`,
              ),
          );
        }

        // Validate event based on type and current state
        switch (eventType) {
          // Text message flow
          case EventType.TEXT_MESSAGE_START: {
            // Can't start a message if one is already in progress
            if (activeMessageId !== undefined) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TEXT_MESSAGE_START' event: A text message is already in progress. Complete it with 'TEXT_MESSAGE_END' first.`,
                  ),
              );
            }

            activeMessageId = (event as any).messageId;
            return of(event);
          }

          case EventType.TEXT_MESSAGE_CONTENT: {
            // Must be in a message and IDs must match
            if (activeMessageId === undefined) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found. Start a text message with 'TEXT_MESSAGE_START' first.`,
                  ),
              );
            }

            if ((event as any).messageId !== activeMessageId) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TEXT_MESSAGE_CONTENT' event: Message ID mismatch. The ID '${(event as any).messageId}' doesn't match the active message ID '${activeMessageId}'.`,
                  ),
              );
            }

            return of(event);
          }

          case EventType.TEXT_MESSAGE_END: {
            // Must be in a message and IDs must match
            if (activeMessageId === undefined) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TEXT_MESSAGE_END' event: No active text message found. A 'TEXT_MESSAGE_START' event must be sent first.`,
                  ),
              );
            }

            if ((event as any).messageId !== activeMessageId) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TEXT_MESSAGE_END' event: Message ID mismatch. The ID '${(event as any).messageId}' doesn't match the active message ID '${activeMessageId}'.`,
                  ),
              );
            }

            // Reset message state
            activeMessageId = undefined;
            return of(event);
          }

          // Tool call flow
          case EventType.TOOL_CALL_START: {
            // Can't start a tool call if one is already in progress
            if (activeToolCallId !== undefined) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TOOL_CALL_START' event: A tool call is already in progress. Complete it with 'TOOL_CALL_END' first.`,
                  ),
              );
            }

            activeToolCallId = (event as any).toolCallId;
            return of(event);
          }

          case EventType.TOOL_CALL_ARGS: {
            // Must be in a tool call and IDs must match
            if (activeToolCallId === undefined) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TOOL_CALL_ARGS' event: No active tool call found. Start a tool call with 'TOOL_CALL_START' first.`,
                  ),
              );
            }

            if ((event as any).toolCallId !== activeToolCallId) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TOOL_CALL_ARGS' event: Tool call ID mismatch. The ID '${(event as any).toolCallId}' doesn't match the active tool call ID '${activeToolCallId}'.`,
                  ),
              );
            }

            return of(event);
          }

          case EventType.TOOL_CALL_END: {
            // Must be in a tool call and IDs must match
            if (activeToolCallId === undefined) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TOOL_CALL_END' event: No active tool call found. A 'TOOL_CALL_START' event must be sent first.`,
                  ),
              );
            }

            if ((event as any).toolCallId !== activeToolCallId) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TOOL_CALL_END' event: Tool call ID mismatch. The ID '${(event as any).toolCallId}' doesn't match the active tool call ID '${activeToolCallId}'.`,
                  ),
              );
            }

            // Reset tool call state
            activeToolCallId = undefined;
            return of(event);
          }

          // Step flow
          case EventType.STEP_STARTED: {
            const stepName = (event as any).name;
            if (activeSteps.has(stepName)) {
              return throwError(
                () => new AGUIError(`Step "${stepName}" is already active for 'STEP_STARTED'`),
              );
            }
            activeSteps.set(stepName, true);
            return of(event);
          }

          case EventType.STEP_FINISHED: {
            const stepName = (event as any).name;
            if (!activeSteps.has(stepName)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'STEP_FINISHED' for step "${stepName}" that was not started`,
                  ),
              );
            }
            activeSteps.delete(stepName);
            return of(event);
          }

          // Run flow
          case EventType.RUN_STARTED: {
            // We've already validated this above
            return of(event);
          }

          case EventType.RUN_FINISHED: {
            // Can't be the first event (already checked)
            // and can't happen after already being finished (already checked)

            // Check that all steps are finished before run ends
            if (activeSteps.size > 0) {
              const unfinishedSteps = Array.from(activeSteps.keys()).join(", ");
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'RUN_FINISHED' while steps are still active: ${unfinishedSteps}`,
                  ),
              );
            }

            runFinished = true;
            return of(event);
          }

          case EventType.RUN_ERROR: {
            // RUN_ERROR can happen at any time
            runError = true; // Set flag to prevent any further events
            return of(event);
          }

          case EventType.CUSTOM: {
            return of(event);
          }

          default: {
            return of(event);
          }
        }
      }),
    );
  };
