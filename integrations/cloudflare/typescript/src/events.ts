export enum EventType {
  TEXT_MESSAGE_START = "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END = "TEXT_MESSAGE_END",
  TOOL_CALL_START = "TOOL_CALL_START",
  TOOL_CALL_ARGS = "TOOL_CALL_ARGS",
  TOOL_CALL_END = "TOOL_CALL_END",
  TOOL_CALL_RESULT = "TOOL_CALL_RESULT",
  RUN_STARTED = "RUN_STARTED",
  RUN_FINISHED = "RUN_FINISHED",
  RUN_ERROR = "RUN_ERROR",
  STEP_STARTED = "STEP_STARTED",
  STEP_FINISHED = "STEP_FINISHED",
  STATE_SYNC = "STATE_SYNC",
  METADATA = "METADATA",
  PROGRESS = "PROGRESS",
  CUSTOM = "CUSTOM",
}

export interface BaseEvent {
  type: EventType;
  timestamp?: number;
  rawEvent?: any;
}

export interface AGUIEvent extends BaseEvent {
  runId?: string;
  data?: any;
  metadata?: Record<string, any>;
}

export class CloudflareAGUIEvents {
  static runStarted(runId: string, metadata?: Record<string, any>): AGUIEvent {
    return {
      type: EventType.RUN_STARTED,
      runId,
      timestamp: Date.now(),
      metadata,
    };
  }

  static runFinished(runId: string, metadata?: Record<string, any>): AGUIEvent {
    return {
      type: EventType.RUN_FINISHED,
      runId,
      timestamp: Date.now(),
      metadata,
    };
  }

  static textMessageStart(runId: string, role: string): AGUIEvent {
    return {
      type: EventType.TEXT_MESSAGE_START,
      runId,
      timestamp: Date.now(),
      data: { role },
    };
  }

  static textMessageContent(runId: string, delta: string): AGUIEvent {
    return {
      type: EventType.TEXT_MESSAGE_CONTENT,
      runId,
      timestamp: Date.now(),
      data: { delta },
    };
  }

  static textMessageEnd(runId: string): AGUIEvent {
    return {
      type: EventType.TEXT_MESSAGE_END,
      runId,
      timestamp: Date.now(),
    };
  }

  static toolCallStart(runId: string, toolCallId: string, toolName: string): AGUIEvent {
    return {
      type: EventType.TOOL_CALL_START,
      runId,
      timestamp: Date.now(),
      data: { toolCallId, toolName },
    };
  }

  static toolCallArgs(runId: string, toolCallId: string, args: string): AGUIEvent {
    return {
      type: EventType.TOOL_CALL_ARGS,
      runId,
      timestamp: Date.now(),
      data: { toolCallId, args },
    };
  }

  static toolCallEnd(runId: string, toolCallId: string): AGUIEvent {
    return {
      type: EventType.TOOL_CALL_END,
      runId,
      timestamp: Date.now(),
      data: { toolCallId },
    };
  }

  static toolCallResult(runId: string, toolCallId: string, result: string): AGUIEvent {
    return {
      type: EventType.TOOL_CALL_RESULT,
      runId,
      timestamp: Date.now(),
      data: { toolCallId, result },
    };
  }

  static error(runId: string, error: Error): AGUIEvent {
    return {
      type: EventType.RUN_ERROR,
      runId,
      timestamp: Date.now(),
      data: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
    };
  }

  static stepStarted(runId: string, stepName: string): AGUIEvent {
    return {
      type: EventType.STEP_STARTED,
      runId,
      timestamp: Date.now(),
      data: { stepName },
    };
  }

  static stepFinished(runId: string, stepName: string): AGUIEvent {
    return {
      type: EventType.STEP_FINISHED,
      runId,
      timestamp: Date.now(),
      data: { stepName },
    };
  }

  static stateSync(runId: string, state: Record<string, any>): AGUIEvent {
    return {
      type: EventType.STATE_SYNC,
      runId,
      timestamp: Date.now(),
      data: { state },
    };
  }

  static metadata(runId: string, metadata: Record<string, any>): AGUIEvent {
    return {
      type: EventType.METADATA,
      runId,
      timestamp: Date.now(),
      data: metadata,
    };
  }

  static progress(runId: string, progress: number, message?: string): AGUIEvent {
    return {
      type: EventType.PROGRESS,
      runId,
      timestamp: Date.now(),
      data: { progress, message },
    };
  }

  static custom(runId: string, name: string, value: any): AGUIEvent {
    return {
      type: EventType.CUSTOM,
      runId,
      timestamp: Date.now(),
      data: { name, value },
    };
  }
}
