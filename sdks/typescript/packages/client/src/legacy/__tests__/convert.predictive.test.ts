import { convertToLegacyEvents } from "../convert";
import { of } from "rxjs";
import {
  BaseEvent,
  EventType,
  CustomEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  StepStartedEvent,
  StepFinishedEvent,
  StateSnapshotEvent,
} from "@ag-ui/core";
import { LegacyRuntimeProtocolEvent } from "../types";
import { toArray } from "rxjs/operators";

describe("convertToLegacyEvents", () => {
  it("should handle predictive state and tool call events", async () => {
    const mockEvents: BaseEvent[] = [
      // First, send a predict state event
      {
        type: EventType.CUSTOM,
        timestamp: Date.now(),
        name: "PredictState",
        value: [
          {
            state_key: "greeting",
            tool: "make_greeting",
            tool_argument: "message",
          },
        ],
      } as CustomEvent,
      // Then, send the tool call start event
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "greeting-1",
        toolCallName: "make_greeting",
      } as ToolCallStartEvent,
      // Send partial JSON arguments in multiple deltas
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "greeting-1",
        delta: '{"message": "Hello',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "greeting-1",
        delta: ' world!"}',
      } as ToolCallArgsEvent,
      // Finally, end the tool call
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "greeting-1",
      } as ToolCallEndEvent,
    ];

    const result = convertToLegacyEvents(
      "test-thread",
      "test-run",
      "test-agent",
    )(of(...mockEvents));

    const events = (await result.pipe(toArray()).toPromise()) as LegacyRuntimeProtocolEvent[];
    expect(events).toHaveLength(7);

    // First event should be the predict state meta event
    expect(events[0].type).toBe("MetaEvent");
    if (events[0].type === "MetaEvent") {
      expect(events[0].name).toBe("PredictState");
      expect(events[0].value).toEqual([
        {
          state_key: "greeting",
          tool: "make_greeting",
          tool_argument: "message",
        },
      ]);
    }

    // Second event should be the tool call start
    expect(events[1].type).toBe("ActionExecutionStart");
    if (events[1].type === "ActionExecutionStart") {
      expect(events[1].actionName).toBe("make_greeting");
      expect(events[1].actionExecutionId).toBe("greeting-1");
    }

    // Third event should be the first tool call args
    expect(events[2].type).toBe("ActionExecutionArgs");
    if (events[2].type === "ActionExecutionArgs") {
      expect(events[2].actionExecutionId).toBe("greeting-1");
      expect(events[2].args).toBe('{"message": "Hello');
    }

    // Fourth event should be the agent state message (after first delta)
    expect(events[3].type).toBe("AgentStateMessage");
    if (events[3].type === "AgentStateMessage") {
      expect(events[3].threadId).toBe("test-thread");
      expect(events[3].agentName).toBe("test-agent");
      expect(events[3].runId).toBe("test-run");
      expect(events[3].active).toBe(true);
      expect(events[3].role).toBe("assistant");
      expect(JSON.parse(events[3].state)).toEqual({ greeting: "Hello" });
      expect(events[3].running).toBe(true);
    }

    // Fifth event should be the second tool call args
    expect(events[4].type).toBe("ActionExecutionArgs");
    if (events[4].type === "ActionExecutionArgs") {
      expect(events[4].actionExecutionId).toBe("greeting-1");
      expect(events[4].args).toBe(' world!"}');
    }

    // Sixth event should be the agent state message (after complete JSON)
    expect(events[5].type).toBe("AgentStateMessage");
    if (events[5].type === "AgentStateMessage") {
      expect(events[5].threadId).toBe("test-thread");
      expect(events[5].agentName).toBe("test-agent");
      expect(events[5].runId).toBe("test-run");
      expect(events[5].active).toBe(true);
      expect(events[5].role).toBe("assistant");
      expect(JSON.parse(events[5].state)).toEqual({ greeting: "Hello world!" });
      expect(events[5].running).toBe(true);
    }

    // Seventh event should be the tool call end
    expect(events[6].type).toBe("ActionExecutionEnd");
    if (events[6].type === "ActionExecutionEnd") {
      expect(events[6].actionExecutionId).toBe("greeting-1");
    }
  });

  it("should handle predictive state without tool_argument, including all args in state", async () => {
    const mockEvents: BaseEvent[] = [
      // First, send a predict state event without tool_argument
      {
        type: EventType.CUSTOM,
        timestamp: Date.now(),
        name: "PredictState",
        value: [
          {
            state_key: "user_preferences",
            tool: "update_preferences",
          },
        ],
      } as CustomEvent,
      // Then, send the tool call start event
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "prefs-1",
        toolCallName: "update_preferences",
      } as ToolCallStartEvent,
      // Send partial JSON arguments in multiple deltas
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "prefs-1",
        delta: '{"theme": "dark", "language": "en',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "prefs-1",
        delta: '", "notifications": true}',
      } as ToolCallArgsEvent,
      // Finally, end the tool call
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "prefs-1",
      } as ToolCallEndEvent,
    ];

    const result = convertToLegacyEvents(
      "test-thread",
      "test-run",
      "test-agent",
    )(of(...mockEvents));

    const events = (await result.pipe(toArray()).toPromise()) as LegacyRuntimeProtocolEvent[];
    expect(events).toHaveLength(7);

    // First event should be the predict state meta event
    expect(events[0].type).toBe("MetaEvent");
    if (events[0].type === "MetaEvent") {
      expect(events[0].name).toBe("PredictState");
      expect(events[0].value).toEqual([
        {
          state_key: "user_preferences",
          tool: "update_preferences",
        },
      ]);
    }

    // Second event should be the tool call start
    expect(events[1].type).toBe("ActionExecutionStart");
    if (events[1].type === "ActionExecutionStart") {
      expect(events[1].actionName).toBe("update_preferences");
      expect(events[1].actionExecutionId).toBe("prefs-1");
    }

    // Third event should be the first tool call args
    expect(events[2].type).toBe("ActionExecutionArgs");
    if (events[2].type === "ActionExecutionArgs") {
      expect(events[2].actionExecutionId).toBe("prefs-1");
      expect(events[2].args).toBe('{"theme": "dark", "language": "en');
    }

    // Fourth event should be the agent state message (after first delta)
    expect(events[3].type).toBe("AgentStateMessage");
    if (events[3].type === "AgentStateMessage") {
      expect(events[3].threadId).toBe("test-thread");
      expect(events[3].agentName).toBe("test-agent");
      expect(events[3].runId).toBe("test-run");
      expect(events[3].active).toBe(true);
      expect(events[3].role).toBe("assistant");
      expect(JSON.parse(events[3].state)).toEqual({
        user_preferences: { theme: "dark", language: "en" },
      });
      expect(events[3].running).toBe(true);
    }

    // Fifth event should be the second tool call args
    expect(events[4].type).toBe("ActionExecutionArgs");
    if (events[4].type === "ActionExecutionArgs") {
      expect(events[4].actionExecutionId).toBe("prefs-1");
      expect(events[4].args).toBe('", "notifications": true}');
    }

    // Sixth event should be the agent state message (after complete JSON)
    expect(events[5].type).toBe("AgentStateMessage");
    if (events[5].type === "AgentStateMessage") {
      expect(events[5].threadId).toBe("test-thread");
      expect(events[5].agentName).toBe("test-agent");
      expect(events[5].runId).toBe("test-run");
      expect(events[5].active).toBe(true);
      expect(events[5].role).toBe("assistant");
      expect(JSON.parse(events[5].state)).toEqual({
        user_preferences: {
          theme: "dark",
          language: "en",
          notifications: true,
        },
      });
      expect(events[5].running).toBe(true);
    }

    // Seventh event should be the tool call end
    expect(events[6].type).toBe("ActionExecutionEnd");
    if (events[6].type === "ActionExecutionEnd") {
      expect(events[6].actionExecutionId).toBe("prefs-1");
    }
  });

  it("should handle step events and state snapshots correctly", async () => {
    const mockEvents: BaseEvent[] = [
      // Start a step
      {
        type: EventType.STEP_STARTED,
        timestamp: Date.now(),
        stepName: "process_task",
      } as StepStartedEvent,
      // Send a predict state event
      {
        type: EventType.CUSTOM,
        timestamp: Date.now(),
        name: "PredictState",
        value: [
          {
            state_key: "current_task",
            tool: "update_task",
          },
        ],
      } as CustomEvent,
      // Start a tool call
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "task-1",
        toolCallName: "update_task",
      } as ToolCallStartEvent,
      // Send tool call args
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "task-1",
        delta: '{"status": "in_progress", "progress": 50, "details": "Processing data"}',
      } as ToolCallArgsEvent,
      // End the tool call
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "task-1",
      } as ToolCallEndEvent,
      // End the step
      {
        type: EventType.STEP_FINISHED,
        timestamp: Date.now(),
        stepName: "process_task",
      } as StepFinishedEvent,
      // Send a state snapshot
      {
        type: EventType.STATE_SNAPSHOT,
        timestamp: Date.now(),
        snapshot: {
          current_task: {
            status: "completed",
            progress: 100,
            details: "Task finished",
          },
        },
      } as StateSnapshotEvent,
      // Start another tool call
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "task-2",
        toolCallName: "update_task",
      } as ToolCallStartEvent,
      // Send tool call args
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "task-2",
        delta: '{"status": "new_task", "progress": 0}',
      } as ToolCallArgsEvent,
      // End the tool call
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "task-2",
      } as ToolCallEndEvent,
    ];

    const result = convertToLegacyEvents(
      "test-thread",
      "test-run",
      "test-agent",
    )(of(...mockEvents));

    const events = (await result.pipe(toArray()).toPromise()) as LegacyRuntimeProtocolEvent[];
    expect(events).toHaveLength(11);

    // First event should be the agent state message (after step start)
    expect(events[0].type).toBe("AgentStateMessage");
    if (events[0].type === "AgentStateMessage") {
      expect(events[0].threadId).toBe("test-thread");
      expect(events[0].agentName).toBe("test-agent");
      expect(events[0].runId).toBe("test-run");
      expect(events[0].active).toBe(true);
      expect(events[0].role).toBe("assistant");
      expect(JSON.parse(events[0].state)).toEqual({});
      expect(events[0].running).toBe(true);
    }

    // Second event should be the predict state meta event
    expect(events[1].type).toBe("MetaEvent");
    if (events[1].type === "MetaEvent") {
      expect(events[1].name).toBe("PredictState");
      expect(events[1].value).toEqual([
        {
          state_key: "current_task",
          tool: "update_task",
        },
      ]);
    }

    // Third event should be the tool call start
    expect(events[2].type).toBe("ActionExecutionStart");
    if (events[2].type === "ActionExecutionStart") {
      expect(events[2].actionName).toBe("update_task");
      expect(events[2].actionExecutionId).toBe("task-1");
    }

    // Fourth event should be the first tool call args
    expect(events[3].type).toBe("ActionExecutionArgs");
    if (events[3].type === "ActionExecutionArgs") {
      expect(events[3].actionExecutionId).toBe("task-1");
      expect(events[3].args).toBe(
        '{"status": "in_progress", "progress": 50, "details": "Processing data"}',
      );
    }

    // Fifth event should be the agent state message (after tool call args)
    expect(events[4].type).toBe("AgentStateMessage");
    if (events[4].type === "AgentStateMessage") {
      expect(events[4].threadId).toBe("test-thread");
      expect(events[4].agentName).toBe("test-agent");
      expect(events[4].runId).toBe("test-run");
      expect(events[4].active).toBe(true);
      expect(events[4].role).toBe("assistant");
      expect(JSON.parse(events[4].state)).toEqual({
        current_task: {
          status: "in_progress",
          progress: 50,
          details: "Processing data",
        },
      });
      expect(events[4].running).toBe(true);
    }

    // Sixth event should be the tool call end
    expect(events[5].type).toBe("ActionExecutionEnd");
    if (events[5].type === "ActionExecutionEnd") {
      expect(events[5].actionExecutionId).toBe("task-1");
    }

    // Seventh event should be the agent state message (after step finished)
    expect(events[6].type).toBe("AgentStateMessage");
    if (events[6].type === "AgentStateMessage") {
      expect(events[6].threadId).toBe("test-thread");
      expect(events[6].agentName).toBe("test-agent");
      expect(events[6].runId).toBe("test-run");
      expect(events[6].active).toBe(false);
      expect(events[6].role).toBe("assistant");
      expect(JSON.parse(events[6].state)).toEqual({
        current_task: {
          status: "in_progress",
          progress: 50,
          details: "Processing data",
        },
      });
      expect(events[6].running).toBe(true);
    }

    // Eighth event should be the agent state message (after state snapshot)
    expect(events[7].type).toBe("AgentStateMessage");
    if (events[7].type === "AgentStateMessage") {
      expect(events[7].threadId).toBe("test-thread");
      expect(events[7].agentName).toBe("test-agent");
      expect(events[7].runId).toBe("test-run");
      expect(events[7].active).toBe(true);
      expect(events[7].role).toBe("assistant");
      expect(JSON.parse(events[7].state)).toEqual({
        current_task: {
          status: "completed",
          progress: 100,
          details: "Task finished",
        },
      });
      expect(events[7].running).toBe(true);
    }

    // Ninth event should be the second tool call start
    expect(events[8].type).toBe("ActionExecutionStart");
    if (events[8].type === "ActionExecutionStart") {
      expect(events[8].actionName).toBe("update_task");
      expect(events[8].actionExecutionId).toBe("task-2");
    }

    // Tenth event should be the second tool call args
    expect(events[9].type).toBe("ActionExecutionArgs");
    if (events[9].type === "ActionExecutionArgs") {
      expect(events[9].actionExecutionId).toBe("task-2");
      expect(events[9].args).toBe('{"status": "new_task", "progress": 0}');
    }

    // Eleventh event should be the second tool call end
    expect(events[10].type).toBe("ActionExecutionEnd");
    if (events[10].type === "ActionExecutionEnd") {
      expect(events[10].actionExecutionId).toBe("task-2");
    }
  });
});
