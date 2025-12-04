import type {
  BaseEvent,
  InputContent,
  Message,
  TextMessageChunkEvent,
  RawEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  ToolCallResultEvent,
  StateDeltaEvent,
  StateSnapshotEvent,
} from "@ag-ui/client";
import { EventType, randomUUID } from "@ag-ui/client";
import type {
  A2AMessage,
  A2APart,
  A2ATextPart,
  A2ADataPart,
  A2AFilePart,
  A2AStreamEvent,
  ConvertAGUIMessagesOptions,
  ConvertedA2AMessages,
  ConvertA2AEventOptions,
  SharedStateTracker,
} from "./types";
import type { Artifact, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from "@a2a-js/sdk";

const ROLE_MAP: Record<string, "user" | "agent" | undefined> = {
  user: "user",
  assistant: "agent",
  tool: "agent",
  system: "user",
  developer: "user",
};

const TOOL_RESULT_PART_TYPE = "tool-result";
const TOOL_CALL_PART_TYPE = "tool-call";
const SURFACE_OPERATION_KEYS = [
  "beginRendering",
  "surfaceUpdate",
  "dataModelUpdate",
] as const;

type SurfaceOperationKey = (typeof SURFACE_OPERATION_KEYS)[number];

const isBinaryContent = (
  content: InputContent,
): content is Extract<InputContent, { type: "binary" }> => content.type === "binary";

const isTextContent = (content: InputContent): content is Extract<InputContent, { type: "text" }> =>
  content.type === "text";

const createTextPart = (text: string): A2ATextPart => ({
  kind: "text",
  text,
});

const createFilePart = (content: Extract<InputContent, { type: "binary" }>): A2AFilePart | null => {
  if (content.url) {
    return {
      kind: "file",
      file: {
        uri: content.url,
        mimeType: content.mimeType,
        name: content.filename,
      },
    };
  }

  if (content.data) {
    return {
      kind: "file",
      file: {
        bytes: content.data,
        mimeType: content.mimeType,
        name: content.filename,
      },
    };
  }

  return null;
};

const extractSurfaceOperation = (
  payload: unknown,
): { surfaceId: string; operation: Record<string, unknown> } | null => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;

  for (const key of SURFACE_OPERATION_KEYS) {
    const value = record[key as SurfaceOperationKey];
    if (value && typeof value === "object" && (value as { surfaceId?: unknown }).surfaceId) {
      const surfaceId = (value as { surfaceId?: unknown }).surfaceId;
      if (typeof surfaceId === "string" && surfaceId.length > 0) {
        return { surfaceId, operation: record };
      }
    }
  }

  return null;
};

const safeJsonParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const cloneValue = <T>(value: T): T => {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
};

const messageContentToParts = (message: Message): A2APart[] => {
  const parts: A2APart[] = [];
  const { content } = message as { content?: Message["content"] };

  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.length > 0) {
      parts.push(createTextPart(trimmed));
    }
  } else if (Array.isArray(content)) {
    for (const chunk of content) {
      if (isTextContent(chunk)) {
        const value = chunk.text.trim();
        if (value.length > 0) {
          parts.push(createTextPart(value));
        }
      } else if (isBinaryContent(chunk)) {
        const filePart = createFilePart(chunk);
        if (filePart) {
          parts.push(filePart);
        }
      } else {
        parts.push({ kind: "data", data: chunk } as A2ADataPart);
      }
    }
  } else if (content && typeof content === "object") {
    parts.push({
      kind: "data",
      data: content as Record<string, unknown>,
    });
  }

  if (message.role === "assistant" && "toolCalls" in message && message.toolCalls?.length) {
    for (const toolCall of message.toolCalls) {
      parts.push({
        kind: "data",
        data: {
          type: TOOL_CALL_PART_TYPE,
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: safeJsonParse(toolCall.function.arguments),
          rawArguments: toolCall.function.arguments,
        },
      });
    }
  }

  if (message.role === "tool") {
    const payload = typeof message.content === "string" ? safeJsonParse(message.content) : message.content;
    parts.push({
      kind: "data",
      data: {
        type: TOOL_RESULT_PART_TYPE,
        toolCallId: message.toolCallId,
        payload,
      },
    });
  }

  return parts;
};

export const ENGRAM_EXTENSION_URI = "urn:agui:engram:v1";
export const DEFAULT_ARTIFACT_BASE_PATH = "/view/artifacts";

export function convertAGUIMessagesToA2A(
  messages: Message[],
  options: ConvertAGUIMessagesOptions = {},
): ConvertedA2AMessages {
  const history: A2AMessage[] = [];
  const includeToolMessages = options.includeToolMessages ?? true;
  const includeSystemMessages = options.includeSystemMessages ?? false;
  const includeDeveloperMessages = options.includeDeveloperMessages ?? false;
  const contextId = options.contextId;
  const taskId = options.taskId;
  const engramExtensionUri = options.engramExtensionUri ?? ENGRAM_EXTENSION_URI;
  const resume = options.resume;

  for (const message of messages) {
    if (message.role === "activity") {
      continue;
    }

    if (message.role === "tool" && !includeToolMessages) {
      continue;
    }

    if (message.role === "system" && !includeSystemMessages) {
      continue;
    }

    if (message.role === "developer" && !includeDeveloperMessages) {
      continue;
    }

    const mappedRole = ROLE_MAP[message.role] ?? (message.role === "tool" ? "agent" : undefined);

    if (!mappedRole) {
      continue;
    }

    const parts = messageContentToParts(message);

    if (parts.length === 0 && mappedRole !== "agent") {
      continue;
    }

    const messageId = message.id ?? randomUUID();
    const metadata: Record<string, unknown> = {};

    if (message.role === "system" || message.role === "developer") {
      metadata.originalRole = message.role;
    }

    history.push({
      kind: "message",
      messageId,
      role: mappedRole,
      parts,
      contextId,
      taskId,
      ...(Object.keys(metadata).length ? { metadata } : {}),
    });
  }

  let targetMessage = history[history.length - 1];

  if (options.engramUpdate) {
    const engramPayload = {
      type: "engram",
      scope: options.engramUpdate.scope ?? "task",
      update: options.engramUpdate.update,
      ...(options.engramUpdate.path ? { path: options.engramUpdate.path } : {}),
    };

    if (!targetMessage || targetMessage.role !== "user") {
      targetMessage = {
        kind: "message",
        messageId: randomUUID(),
        role: "user",
        parts: [],
        contextId,
        taskId,
      };
      history.push(targetMessage);
    }

    const currentExtensions = new Set(targetMessage.extensions ?? []);
    currentExtensions.add(engramExtensionUri);

    targetMessage.parts = [
      ...(targetMessage.parts ?? []),
      {
        kind: "data",
        data: engramPayload,
      } as A2ADataPart,
    ];
    targetMessage.extensions = Array.from(currentExtensions);
    targetMessage.contextId = targetMessage.contextId ?? contextId;
    targetMessage.taskId = targetMessage.taskId ?? taskId;
  }

  if (resume) {
    if (!targetMessage || targetMessage.role !== "user") {
      targetMessage = {
        kind: "message",
        messageId: randomUUID(),
        role: "user",
        parts: [],
        contextId,
        taskId,
      };
      history.push(targetMessage);
    }

    const inputResponsePayload = {
      type: "a2a.input.response",
      interruptId: resume.interruptId,
      values: resume.payload,
      payload: resume.payload,
    };

      targetMessage.parts = [
        ...(targetMessage.parts ?? []),
        {
          kind: "data",
          data: inputResponsePayload,
        } as A2ADataPart,
      ];
    targetMessage.contextId = targetMessage.contextId ?? contextId;
    targetMessage.taskId = targetMessage.taskId ?? taskId;
  }

  const latestUserMessage = [...history].reverse().find((msg) => msg.role === "user");

  const metadata: Record<string, unknown> = {};

  if (options.context?.length) {
    metadata.context = options.context;
  }

  if (options.engramUpdate) {
    metadata.engram = options.engramUpdate;
  }

  if (resume) {
    metadata.resume = resume;
  }

  return {
    contextId,
    taskId,
    history,
    latestUserMessage,
    targetMessage,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  };
}

const createStateSnapshotEvent = (
  tracker: SharedStateTracker,
  rawEvent?: unknown,
): StateSnapshotEvent => ({
  type: EventType.STATE_SNAPSHOT,
  snapshot: cloneValue(tracker.state),
  rawEvent,
});

const collectStateEvents = (
  tracker: SharedStateTracker,
  rawEvent: unknown,
  ...stateEvents: Array<StateDeltaEvent | StateSnapshotEvent | null | undefined>
): BaseEvent[] => {
  const events: BaseEvent[] = [];

  if (!tracker.emittedSnapshot) {
    tracker.emittedSnapshot = true;
    events.push(createStateSnapshotEvent(tracker, rawEvent));
  }

  for (const stateEvent of stateEvents) {
    if (stateEvent) {
      events.push(stateEvent);
    }
  }

  return events;
};

const removeSharedStatePath = (
  tracker: SharedStateTracker,
  path: string,
  options: { rawEvent?: unknown } = {},
): StateDeltaEvent | null => {
  const segments = (path.startsWith("/") ? path.slice(1) : path).split("/").filter(Boolean);
  if (segments.length === 0) {
    tracker.state = {};
    return {
      type: EventType.STATE_DELTA,
      delta: [{ op: "remove", path: "/" }],
      rawEvent: options.rawEvent,
    };
  }

  let cursor: Record<string, unknown> = tracker.state;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index];
    const nextValue = cursor[key];

    if (typeof nextValue !== "object" || nextValue === null || Array.isArray(nextValue)) {
      return null;
    }

    cursor = nextValue as Record<string, unknown>;
  }

  const leafKey = segments[segments.length - 1];
  if (!(leafKey in cursor)) {
    return null;
  }

  delete cursor[leafKey];

  return {
    type: EventType.STATE_DELTA,
    delta: [{ op: "remove", path: normalizeJsonPointer(path) }],
    rawEvent: options.rawEvent,
  };
};

const getPendingInterruptEntries = (
  tracker: SharedStateTracker,
): Record<string, { taskId?: string; [key: string]: unknown }> => {
  const view = (tracker.state.view ?? {}) as Record<string, unknown>;
  const pending = view.pendingInterrupts;

  if (pending && typeof pending === "object" && !Array.isArray(pending)) {
    return pending as Record<string, { taskId?: string; [key: string]: unknown }>;
  }

  return {};
};

const findPendingInterruptForTask = (
  tracker: SharedStateTracker,
  taskId?: string,
): { interruptId: string; entry: { [key: string]: unknown } } | null => {
  if (!taskId) {
    return null;
  }

  const pendingEntries = getPendingInterruptEntries(tracker);

  for (const [interruptId, entry] of Object.entries(pendingEntries)) {
    if (entry && typeof entry === "object" && (entry as { taskId?: string }).taskId === taskId) {
      return { interruptId, entry };
    }
  }

  return null;
};

const findPendingInterruptById = (
  tracker: SharedStateTracker,
  interruptId?: string,
): { interruptId: string; entry: { [key: string]: unknown } } | null => {
  if (!interruptId) {
    return null;
  }

  const pendingEntries = getPendingInterruptEntries(tracker);
  const entry = pendingEntries[interruptId];

  if (entry && typeof entry === "object") {
    return { interruptId, entry };
  }

  return null;
};

const findPendingInterruptByRequestId = (
  tracker: SharedStateTracker,
  taskId?: string,
  requestId?: string,
): { interruptId: string; entry: { [key: string]: unknown } } | null => {
  if (!requestId) {
    return null;
  }

  const pendingEntries = getPendingInterruptEntries(tracker);

  for (const [interruptId, entry] of Object.entries(pendingEntries)) {
    if (
      entry &&
      typeof entry === "object" &&
      (entry as { taskId?: string }).taskId === taskId &&
      (entry as { requestId?: string }).requestId === requestId
    ) {
      return { interruptId, entry };
    }
  }

  return null;
};

const deriveInterruptId = (
  taskId: string | undefined,
  requestId?: string,
  statusMessageId?: string,
): string => {
  const sourceId = (requestId ?? statusMessageId ?? "pending").toString();
  const normalizedSource = sourceId.trim().length > 0 ? sourceId.trim() : "pending";
  const normalizedTask = (taskId ?? "task").toString().trim() || "task";
  return `input-${normalizedTask}-${normalizedSource}`;
};

const resolveDecisionFromState = (state?: string): string | undefined => {
  if (!state) {
    return undefined;
  }

  if (state === "rejected" || state === "failed" || state === "canceled") {
    return "rejected";
  }

  if (state === "working" || state === "input-required") {
    return "provided";
  }

  return "approved";
};

const resolveStageFromState = (state?: string): string | undefined => {
  if (!state) {
    return undefined;
  }

  if (state === "input-required") {
    return "awaiting_input";
  }

  if (state === "working") {
    return "working";
  }

  return "completed";
};

const extractInputRequestData = (
  message?: A2AMessage,
): { request: Record<string, unknown>; requestId?: string; reason?: string } | null => {
  if (!message || message.kind !== "message") {
    return null;
  }

  let requestPayload: Record<string, unknown> | null = null;

  for (const part of message.parts ?? []) {
    if (part.kind !== "data") {
      continue;
    }

    const data = (part as A2ADataPart).data;
    if (data && typeof data === "object" && (data as { type?: unknown }).type === "a2a.input.request") {
      requestPayload = data as Record<string, unknown>;
      break;
    }
  }

  if (!requestPayload) {
    return null;
  }

  const reason = (message.parts ?? [])
    .filter((part): part is A2ATextPart => part.kind === "text")
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();

  const requestId =
    typeof (requestPayload as { formId?: unknown; requestId?: unknown }).formId === "string"
      ? (requestPayload as { formId?: string }).formId
      : typeof (requestPayload as { requestId?: unknown }).requestId === "string"
        ? (requestPayload as { requestId?: string }).requestId
      : undefined;

  return {
    request: requestPayload,
    requestId,
    reason: reason || undefined,
  };
};

const isA2AMessage = (event: A2AStreamEvent): event is A2AMessage => event.kind === "message";

const isA2ATask = (event: A2AStreamEvent): event is Task => event.kind === "task";

const isA2AStatusUpdate = (
  event: A2AStreamEvent,
): event is TaskStatusUpdateEvent => event.kind === "status-update";

const isA2AArtifactUpdate = (
  event: A2AStreamEvent,
): event is TaskArtifactUpdateEvent => event.kind === "artifact-update";

const getEventTaskId = (event: A2AStreamEvent): string | undefined => {
  if (isA2ATask(event)) {
    return event.id;
  }

  if (isA2AStatusUpdate(event) || isA2AArtifactUpdate(event)) {
    return event.taskId;
  }

  if (isA2AMessage(event)) {
    return event.taskId;
  }

  return undefined;
};

const shouldIgnoreEventForTask = (event: A2AStreamEvent, options: ConvertA2AEventOptions): boolean => {
  const targetTaskId = options.taskId;
  if (!targetTaskId) {
    return false;
  }

  const eventTaskId = getEventTaskId(event);
  return Boolean(eventTaskId && eventTaskId !== targetTaskId);
};

type JsonPatchOperation = {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
};

const encodeJsonPointerSegment = (segment: string): string =>
  segment.replace(/~/g, "~0").replace(/\//g, "~1");

const normalizeJsonPointer = (path: string): string => {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const segments = normalized
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeJsonPointerSegment(segment));

  return `/${segments.join("/")}`;
};

const captureContextId = (contextId: unknown, options: ConvertA2AEventOptions) => {
  if (typeof contextId === "string" && contextId.trim().length > 0) {
    options.onContextId?.(contextId);
  }
};

const applySharedStateUpdate = (
  tracker: SharedStateTracker,
  path: string,
  value: unknown,
  options: { append?: boolean; rawEvent?: unknown; includeContainers?: boolean } = {},
): StateDeltaEvent => {
  const segments = (path.startsWith("/") ? path.slice(1) : path).split("/").filter(Boolean);
  const encodedPath = normalizeJsonPointer(path);
  const containerOps: JsonPatchOperation[] = [];
  const includeContainers = options.includeContainers ?? true;

  if (segments.length === 0) {
    tracker.state = value as Record<string, unknown>;
    return {
      type: EventType.STATE_DELTA,
      delta: [{ op: "replace", path: encodedPath, value }],
      rawEvent: options.rawEvent,
    };
  }

  let cursor: Record<string, unknown> = tracker.state;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index];
    const nextValue = cursor[key];
    const containerPath = normalizeJsonPointer(segments.slice(0, index + 1).join("/"));

    if (includeContainers && (typeof nextValue !== "object" || nextValue === null || Array.isArray(nextValue))) {
      const op: JsonPatchOperation["op"] = nextValue === undefined ? "add" : "replace";
      cursor[key] = {};
      containerOps.push({
        op,
        path: containerPath,
        value: {},
      });
    } else if (typeof nextValue !== "object" || nextValue === null || Array.isArray(nextValue)) {
      cursor[key] = {};
    }

    cursor = cursor[key] as Record<string, unknown>;
  }

  const leafKey = segments[segments.length - 1];
  const currentValue = cursor[leafKey];
  let nextValue = value;
  let delta: JsonPatchOperation[];

  if (options.append) {
    if (typeof currentValue === "string" && typeof value === "string") {
      nextValue = currentValue + value;
      delta = [
        {
          op: "replace",
          path: encodedPath,
          value: nextValue,
        },
      ];
    } else if (Array.isArray(currentValue)) {
      cursor[leafKey] = [...currentValue, value];
      delta = [
        {
          op: "add",
          path: `${encodedPath}/-`,
          value,
        },
      ];

      return {
        type: EventType.STATE_DELTA,
        delta: [...containerOps, ...delta],
        rawEvent: options.rawEvent,
      };
    } else if (currentValue === undefined) {
      nextValue = Array.isArray(value) ? value : [value];
      delta = [
        {
          op: "add",
          path: encodedPath,
          value: nextValue,
        },
      ];
    } else {
      nextValue = [currentValue, value];
      delta = [
        {
          op: "replace",
          path: encodedPath,
          value: nextValue,
        },
      ];
    }
  } else {
    const op: JsonPatchOperation["op"] = currentValue === undefined ? "add" : "replace";
    delta = [
      {
        op,
        path: encodedPath,
        value,
      },
    ];
  }

  cursor[leafKey] = nextValue;

  return {
    type: EventType.STATE_DELTA,
    delta: [...containerOps, ...delta],
    rawEvent: options.rawEvent,
  };
};

const resolveArtifactPath = (artifact: Artifact, artifactBasePath?: string): string => {
  const metadata = (artifact.metadata ?? {}) as Record<string, unknown>;
  const metadataPath =
    typeof metadata.path === "string" ? (metadata.path as string) : undefined;

  if (metadataPath && metadataPath.trim().length > 0) {
    const normalized = metadataPath.trim();
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  }

  const sanitizedBase = (artifactBasePath ?? DEFAULT_ARTIFACT_BASE_PATH).replace(/\/$/, "");
  return `${sanitizedBase}/${artifact.artifactId}`;
};

function resolveMappedMessageId(
  originalId: string,
  options: ConvertA2AEventOptions,
  aliasKey?: string,
): string {
  if (aliasKey) {
    const existingAliasId = options.messageIdMap.get(aliasKey);
    if (existingAliasId) {
      options.messageIdMap.set(originalId, existingAliasId);
      return existingAliasId;
    }
  }

  const existingId = options.messageIdMap.get(originalId);
  if (existingId) {
    if (aliasKey) {
      options.messageIdMap.set(aliasKey, existingId);
    }
    return existingId;
  }

  const newId = randomUUID();
  options.messageIdMap.set(originalId, newId);
  if (aliasKey) {
    options.messageIdMap.set(aliasKey, newId);
  }
  return newId;
}

function convertMessageToEvents(
  message: A2AMessage,
  options: ConvertA2AEventOptions,
  aliasKey?: string,
): BaseEvent[] {
  captureContextId(message.contextId, options);

  const role = options.role ?? "assistant";
  const events: BaseEvent[] = [];

  const originalId = message.messageId ?? randomUUID();
  const mappedId = resolveMappedMessageId(originalId, options, aliasKey);

  const openToolCalls = new Set<string>();

  for (const part of message.parts ?? []) {
    if (part.kind === "text") {
      const textPart = part as A2ATextPart;
      const partText = textPart.text ?? "";
      if (partText) {
        const previousText = options.getCurrentText?.(mappedId) ?? "";

        if (partText !== previousText) {
          const deltaText = partText.startsWith(previousText)
            ? partText.slice(previousText.length)
            : partText;

          if (deltaText.length > 0) {
            const chunkEvent: TextMessageChunkEvent = {
              type: EventType.TEXT_MESSAGE_CHUNK,
              messageId: mappedId,
              role,
              delta: deltaText,
            };
            options.onTextDelta?.({ messageId: mappedId, delta: deltaText });
            events.push(chunkEvent);
          }
        }
      }
      continue;
    }

    if (part.kind === "data") {
      const dataPart = part as A2ADataPart;
      const payload = dataPart.data;

      if (payload && typeof payload === "object") {
        const payloadRecord = payload as Record<string, unknown>;
        const payloadType = payloadRecord.type;

        if (payloadType === TOOL_CALL_PART_TYPE) {
          const toolCallId =
            typeof payloadRecord.id === "string" ? payloadRecord.id : randomUUID();
          const toolCallName =
            typeof payloadRecord.name === "string" ? payloadRecord.name : "unknown_tool";
          const args = payloadRecord.arguments;

          const startEvent: ToolCallStartEvent = {
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName,
            parentMessageId: mappedId,
          };
          events.push(startEvent);

          if (args !== undefined) {
            const argsEvent: ToolCallArgsEvent = {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId,
              delta: JSON.stringify(args),
            };
            events.push(argsEvent);
          }

          openToolCalls.add(toolCallId);
          continue;
        }

        if (payloadType === TOOL_RESULT_PART_TYPE && payloadRecord.toolCallId) {
          const toolCallId = String(payloadRecord.toolCallId);
          const toolResultEvent: ToolCallResultEvent = {
            type: EventType.TOOL_CALL_RESULT,
            toolCallId,
            content: JSON.stringify(payloadRecord.payload ?? payloadRecord),
            messageId: randomUUID(),
            role: "tool",
          };
          events.push(toolResultEvent);

          if (openToolCalls.has(toolCallId)) {
            const endEvent: ToolCallEndEvent = {
              type: EventType.TOOL_CALL_END,
              toolCallId,
            };
            events.push(endEvent);
            openToolCalls.delete(toolCallId);
          }

          continue;
        }

        if (payloadType === "a2a.input.response" && options.sharedStateTracker) {
          const tracker = options.sharedStateTracker;
          const responseInterruptId =
            typeof (payloadRecord as { interruptId?: unknown }).interruptId === "string"
              ? (payloadRecord as { interruptId: string }).interruptId
              : undefined;
          const responseRequestId =
            typeof (payloadRecord as { requestId?: unknown }).requestId === "string"
              ? (payloadRecord as { requestId: string }).requestId
              : undefined;

          const pending =
            findPendingInterruptById(tracker, responseInterruptId) ??
            findPendingInterruptByRequestId(tracker, message.taskId, responseRequestId) ??
            findPendingInterruptForTask(tracker, message.taskId);

          const interruptId =
            pending?.interruptId ??
            deriveInterruptId(
              message.taskId,
              responseRequestId,
              message.messageId,
            );

          if (pending) {
            events.push({
              type: EventType.ACTIVITY_DELTA,
              messageId: interruptId,
              activityType: "INPUT_REQUIRED",
              patch: [
                { op: "replace", path: "/stage", value: "working" },
                { op: "replace", path: "/decision", value: "provided" },
                {
                  op: "add",
                  path: "/response",
                  value: payloadRecord.values ?? payloadRecord,
                },
              ],
            } as BaseEvent);

            const removeEvent = removeSharedStatePath(
              tracker,
              `/view/pendingInterrupts/${interruptId}`,
              { rawEvent: message },
            );

            if (removeEvent) {
              events.push(...collectStateEvents(tracker, message, removeEvent));
            }
          }

          continue;
        }

        const surfaceOperation = extractSurfaceOperation(payloadRecord);
        if (surfaceOperation && options.surfaceTracker) {
          const tracker = options.surfaceTracker;
          const { surfaceId, operation } = surfaceOperation;
          const hasSeenSurface = tracker.has(surfaceId);

          if (!hasSeenSurface) {
            tracker.add(surfaceId);
            events.push({
              type: EventType.ACTIVITY_SNAPSHOT,
              messageId: surfaceId,
              activityType: "a2ui-surface",
              content: { operations: [] },
              replace: false,
            } as BaseEvent);
          }

          events.push({
            type: EventType.ACTIVITY_DELTA,
            messageId: surfaceId,
            activityType: "a2ui-surface",
            patch: [
              {
                op: "add",
                path: "/operations/-",
                value: operation,
              },
            ],
          } as BaseEvent);

          continue;
        }

        continue;
      }

      continue;
    }

    // Ignore other part kinds for now.
  }

  for (const toolCallId of openToolCalls) {
    const endEvent: ToolCallEndEvent = {
      type: EventType.TOOL_CALL_END,
      toolCallId,
    };
    events.push(endEvent);
  }

  return events;
}

const projectStatusUpdate = (
  event: TaskStatusUpdateEvent,
  options: ConvertA2AEventOptions,
): BaseEvent[] => {
  captureContextId(event.contextId, options);

  const events: BaseEvent[] = [];
  const statusMessage = event.status?.message;
  const statusState = event.status?.state;
  const aliasKey = statusState && statusState !== "input-required" ? `${event.taskId}:status` : undefined;
  const tracker = options.sharedStateTracker;
  const stateDeltas: Array<StateDeltaEvent | null | undefined> = [];
  const statusText =
    statusMessage && statusMessage.kind === "message"
      ? (statusMessage.parts ?? [])
          .filter((part): part is A2ATextPart => part.kind === "text")
          .map((part) => part.text ?? "")
          .filter(Boolean)
          .join("\n")
          .trim()
      : undefined;

  if (statusMessage && statusMessage.kind === "message") {
    events.push(...convertMessageToEvents(statusMessage as A2AMessage, options, aliasKey));
  }

  let runFinishedEvent: BaseEvent | undefined;

  if (tracker) {
    const statusValue: Record<string, unknown> = {
      state: statusState,
      taskId: event.taskId,
    };

    if (event.contextId) {
      statusValue.contextId = event.contextId;
    }

    if (event.status?.timestamp !== undefined) {
      statusValue.timestamp = event.status.timestamp;
    }

    if (statusMessage?.kind === "message") {
      statusValue.messageId = statusMessage.messageId;
    }

    if (statusText) {
      statusValue.messageText = statusText;
    }

    const includeContainers = tracker.emittedSnapshot === true;

    stateDeltas.push(
      applySharedStateUpdate(tracker, `/view/tasks/${event.taskId}/status`, statusValue, {
        rawEvent: event,
        includeContainers,
      }),
    );
    stateDeltas.push(
      applySharedStateUpdate(tracker, `/view/tasks/${event.taskId}/contextId`, event.contextId, {
        rawEvent: event,
        includeContainers,
      }),
    );

    if (options.runId) {
      stateDeltas.push(
        applySharedStateUpdate(tracker, `/view/tasks/${event.taskId}/lastRunId`, options.runId, {
          rawEvent: event,
          includeContainers,
        }),
      );
    }

    const formData = statusState === "input-required" ? extractInputRequestData(statusMessage as A2AMessage) : null;
    const interruptId =
      statusState === "input-required"
        ? deriveInterruptId(
            event.taskId,
            formData?.requestId,
            statusMessage?.kind === "message" ? statusMessage.messageId : undefined,
          )
        : undefined;
    const existingPending =
      findPendingInterruptById(tracker, interruptId) ??
      findPendingInterruptByRequestId(tracker, event.taskId, formData?.requestId) ??
      findPendingInterruptForTask(tracker, event.taskId);

    if (statusState === "input-required") {
      const resolvedInterruptId =
        interruptId ??
        existingPending?.interruptId ??
        deriveInterruptId(
          event.taskId,
          formData?.requestId,
          statusMessage?.kind === "message" ? statusMessage.messageId : undefined,
        );
      const reason = formData?.reason ?? statusText;

      stateDeltas.push(
        applySharedStateUpdate(
          tracker,
          `/view/tasks/${event.taskId}/lastInterruptId`,
          resolvedInterruptId,
          { rawEvent: event, includeContainers },
        ),
      );
      stateDeltas.push(
        applySharedStateUpdate(
          tracker,
          `/view/pendingInterrupts/${resolvedInterruptId}`,
          {
            interruptId: resolvedInterruptId,
            taskId: event.taskId,
            requestId: formData?.requestId,
            request: formData?.request,
            reason,
            contextId: event.contextId,
          },
          { rawEvent: event, includeContainers },
        ),
      );

      events.push({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: resolvedInterruptId,
        activityType: "INPUT_REQUIRED",
        content: {
          stage: "awaiting_input",
          taskId: event.taskId,
          contextId: event.contextId,
          request: formData?.request,
          reason,
        },
        replace: false,
      } as BaseEvent);

      if (options.threadId && options.runId) {
        runFinishedEvent = {
          type: EventType.RUN_FINISHED,
          threadId: options.threadId,
          runId: options.runId,
          result: {
            outcome: "interrupt",
            taskId: event.taskId,
            contextId: event.contextId,
            interruptId: resolvedInterruptId,
            request: formData?.request,
          },
          rawEvent: event,
        } as BaseEvent;
      }
    } else if (existingPending) {
      const decision = resolveDecisionFromState(statusState);
      const stage = resolveStageFromState(statusState);

      if (stage || decision) {
        events.push({
          type: EventType.ACTIVITY_DELTA,
          messageId: existingPending.interruptId,
          activityType: "INPUT_REQUIRED",
          patch: [
            ...(stage ? [{ op: "replace", path: "/stage", value: stage }] : []),
            ...(decision ? [{ op: "replace", path: "/decision", value: decision }] : []),
          ],
        } as BaseEvent);
      }

      stateDeltas.push(
        removeSharedStatePath(
          tracker,
          `/view/pendingInterrupts/${existingPending.interruptId}`,
          { rawEvent: event },
        ),
      );
    }
  }

  if (tracker && stateDeltas.some(Boolean)) {
    events.push(...collectStateEvents(tracker, event, ...stateDeltas));
  }

  if (runFinishedEvent) {
    events.push(runFinishedEvent);
  }

  if (events.length === 0) {
    events.push({
      type: EventType.RAW,
      event,
      source: options.source ?? "a2a",
    } as RawEvent);
  }

  return events;
};

const projectArtifactUpdate = (
  event: TaskArtifactUpdateEvent,
  options: ConvertA2AEventOptions,
): BaseEvent[] => {
  captureContextId(event.contextId, options);

  const artifactPath = resolveArtifactPath(event.artifact, options.artifactBasePath);
  const append = event.append ?? false;
  const aliasKey = `artifact:${event.artifact.artifactId}`;
  const tracker = options.sharedStateTracker;
  const stateDeltas: Array<StateDeltaEvent | null | undefined> = [];
  const includeContainers = tracker?.emittedSnapshot === true;
  const textEvents: BaseEvent[] = [];

  for (const part of event.artifact.parts ?? []) {
    if (part.kind === "text") {
      const message: A2AMessage = {
        kind: "message",
        messageId: event.artifact.artifactId,
        role: "agent",
        parts: [part],
        contextId: event.contextId,
        taskId: event.taskId,
      };

      textEvents.push(...convertMessageToEvents(message, options, aliasKey));

      if (tracker) {
        stateDeltas.push(
          applySharedStateUpdate(tracker, artifactPath, (part as A2ATextPart).text ?? "", {
            append,
            rawEvent: event,
            includeContainers,
          }),
        );
      }

      continue;
    }

    if (part.kind === "data" && tracker) {
      stateDeltas.push(
        applySharedStateUpdate(tracker, artifactPath, (part as A2ADataPart).data, {
          append,
          rawEvent: event,
          includeContainers,
        }),
      );
      continue;
    }

    if (part.kind === "file" && tracker) {
      stateDeltas.push(
        applySharedStateUpdate(tracker, artifactPath, (part as A2AFilePart).file, {
          append,
          rawEvent: event,
          includeContainers,
        }),
      );
    }
  }

  const events: BaseEvent[] = [];

  if (tracker && stateDeltas.some(Boolean)) {
    events.push(...collectStateEvents(tracker, event, ...stateDeltas));
  }

  events.push(...textEvents);

  if (events.length === 0) {
    events.push({
      type: EventType.RAW,
      event,
      source: options.source ?? "a2a",
    } as RawEvent);
  }

  return events;
};

const projectTask = (
  event: Task,
  options: ConvertA2AEventOptions,
): BaseEvent[] => {
  captureContextId(event.contextId, options);

  const events: BaseEvent[] = [];
  const tracker = options.sharedStateTracker;
  const stateDeltas: Array<StateDeltaEvent | null | undefined> = [];
  const includeContainers = tracker?.emittedSnapshot === true;
  const shouldEmitDelta = tracker?.emittedSnapshot === true;
  const statusMessage = event.status?.message;
  const statusState = event.status?.state;
  const statusText =
    statusMessage && statusMessage.kind === "message"
      ? (statusMessage.parts ?? [])
          .filter((part): part is A2ATextPart => part.kind === "text")
          .map((part) => part.text ?? "")
          .filter(Boolean)
          .join("\n")
          .trim()
      : undefined;
  let runFinishedEvent: BaseEvent | undefined;

  if (tracker) {
    const taskProjection = {
      taskId: event.id,
      contextId: event.contextId,
      status: event.status,
    };

    const projectionDelta = applySharedStateUpdate(
      tracker,
      `/view/tasks/${event.id}`,
      taskProjection,
      {
        rawEvent: event,
        includeContainers,
      },
    );

    if (shouldEmitDelta) {
      stateDeltas.push(projectionDelta);
    }

    if (options.runId) {
      const lastRunDelta = applySharedStateUpdate(
        tracker,
        `/view/tasks/${event.id}/lastRunId`,
        options.runId,
        { rawEvent: event, includeContainers },
      );

      if (shouldEmitDelta) {
        stateDeltas.push(lastRunDelta);
      }
    }

    if (statusState === "input-required") {
      const formData = extractInputRequestData(statusMessage as A2AMessage);
      const interruptId = deriveInterruptId(
        event.id,
        formData?.requestId,
        statusMessage?.kind === "message" ? statusMessage.messageId : undefined,
      );

      const lastInterruptDelta = applySharedStateUpdate(
        tracker,
        `/view/tasks/${event.id}/lastInterruptId`,
        interruptId,
        { rawEvent: event, includeContainers },
      );
      const pendingDelta = applySharedStateUpdate(
        tracker,
        `/view/pendingInterrupts/${interruptId}`,
        {
          interruptId,
          taskId: event.id,
          requestId: formData?.requestId,
          request: formData?.request,
          reason: formData?.reason ?? statusText,
          contextId: event.contextId,
        },
        { rawEvent: event, includeContainers },
      );

      if (shouldEmitDelta) {
        stateDeltas.push(lastInterruptDelta, pendingDelta);
      }

      events.push({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: interruptId,
        activityType: "INPUT_REQUIRED",
        content: {
          stage: "awaiting_input",
          taskId: event.id,
          contextId: event.contextId,
          request: formData?.request,
          reason: formData?.reason ?? statusText,
        },
        replace: false,
      } as BaseEvent);

      if (options.threadId && options.runId) {
        runFinishedEvent = {
          type: EventType.RUN_FINISHED,
          threadId: options.threadId,
          runId: options.runId,
          result: {
            outcome: "interrupt",
            taskId: event.id,
            contextId: event.contextId,
            interruptId,
            request: formData?.request,
          },
          rawEvent: event,
        } as BaseEvent;
      }
    }
  }

  for (const message of event.history ?? []) {
    events.push(...convertMessageToEvents(message as A2AMessage, options));
  }

  for (const artifact of event.artifacts ?? []) {
    events.push(
      ...projectArtifactUpdate(
        {
          kind: "artifact-update",
          contextId: event.contextId,
          taskId: event.id,
          artifact,
          append: false,
          lastChunk: true,
        },
        options,
      ),
    );
  }

  const stateEvents = tracker
    ? stateDeltas.some(Boolean)
      ? collectStateEvents(tracker, event, ...stateDeltas)
      : collectStateEvents(tracker, event)
    : [];

  const finalEvents = [
    ...stateEvents,
    ...events,
    ...(runFinishedEvent ? [runFinishedEvent] : []),
  ];

  if (finalEvents.length === 0) {
    finalEvents.push({
      type: EventType.RAW,
      event,
      source: options.source ?? "a2a",
    } as RawEvent);
  }

  return finalEvents;
};

export function convertA2AEventToAGUIEvents(
  event: A2AStreamEvent,
  options: ConvertA2AEventOptions,
): BaseEvent[] {
  if (shouldIgnoreEventForTask(event, options)) {
    return [];
  }

  if (isA2AMessage(event)) {
    return convertMessageToEvents(event, options);
  }

  if (isA2AStatusUpdate(event)) {
    return projectStatusUpdate(event, options);
  }

  if (isA2AArtifactUpdate(event)) {
    return projectArtifactUpdate(event, options);
  }

  if (isA2ATask(event)) {
    return projectTask(event, options);
  }

  const source = options.source ?? "a2a";
  const fallbackEvent: RawEvent = {
    type: EventType.RAW,
    event,
    source,
  };

  return [fallbackEvent];
}

export const createSharedStateTracker = (
  initialState?: Record<string, unknown>,
): SharedStateTracker => {
  const clone = initialState === undefined ? {} : cloneValue(initialState);

  return {
    state: clone,
    emittedSnapshot: false,
  };
};

export const sendMessageToA2AAgentTool = {
  name: "send_message_to_a2a_agent",
  description:
    "Sends a task to the agent named `agentName`, including the full conversation context and goal",
  parameters: {
    type: "object",
    properties: {
      agentName: {
        type: "string",
        description: "The name of the A2A agent to send the message to.",
      },
      task: {
        type: "string",
        description:
          "The comprehensive conversation-context summary and goal to be achieved regarding the user inquiry.",
      },
    },
    required: ["task"],
  },
} as const;
