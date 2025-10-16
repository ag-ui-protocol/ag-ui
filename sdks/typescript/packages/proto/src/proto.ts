import {
  BaseEvent,
  EventSchemas,
  EventType,
  InputContent,
  Message,
} from "@ag-ui/core";
import * as protoEvents from "./generated/events";
import * as protoPatch from "./generated/patch";

function toCamelCase(str: string): string {
  return str.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function toProtoContent(content: InputContent) {
  if (content.type === "text") {
    return {
      text: {
        text: content.text,
      },
    };
  }

  return {
    binary: {
      mimeType: content.mimeType,
      id: content.id,
      url: content.url,
      data: content.data,
      filename: content.filename,
    },
  };
}

function fromProtoContent(content: any): InputContent {
  if (content.text) {
    return {
      type: "text",
      text: content.text.text ?? "",
    };
  }

  const binary = content.binary ?? {};
  return {
    type: "binary",
    mimeType: binary.mimeType ?? "",
    id: binary.id ?? undefined,
    url: binary.url ?? undefined,
    data: binary.data ?? undefined,
    filename: binary.filename ?? undefined,
  };
}

/**
 * Encodes an event message to a protocol buffer binary format.
 */
export function encode(event: BaseEvent): Uint8Array {
  const oneofField = toCamelCase(event.type);
  const { type, timestamp, rawEvent, ...rest } = event as any;

  // since protobuf does not support optional arrays, we need to ensure that the toolCalls array is always present
  if (type === EventType.MESSAGES_SNAPSHOT) {
    rest.messages = rest.messages.map((message: Message) => {
      const untypedMessage = message as any;
      const toolCalls = untypedMessage.toolCalls ?? [];
      const content = untypedMessage.content;
      const isContentArray = Array.isArray(content);

      return {
        ...message,
        toolCalls,
        content: isContentArray ? undefined : content,
        contentParts: isContentArray
          ? (content as InputContent[]).map(toProtoContent)
          : [],
      };
    });
  }

  // custom mapping for json patch operations
  if (type === EventType.STATE_DELTA) {
    rest.delta = rest.delta.map((operation: any) => ({
      ...operation,
      op: protoPatch.JsonPatchOperationType[operation.op.toUpperCase()],
    }));
  }

  const eventMessage = {
    [oneofField]: {
      baseEvent: {
        type: protoEvents.EventType[event.type as keyof typeof protoEvents.EventType],
        timestamp,
        rawEvent,
      },
      ...rest,
    },
  };
  return protoEvents.Event.encode(eventMessage).finish();
}

/**
 * Decodes a protocol buffer binary format to an event message.
 * The format includes a 4-byte length prefix followed by the message.
 */
export function decode(data: Uint8Array): BaseEvent {
  const event = protoEvents.Event.decode(data, data.length);
  const decoded = Object.values(event).find((value) => value !== undefined) as any;
  if (!decoded) {
    throw new Error("Invalid event");
  }
  decoded.type = protoEvents.EventType[decoded.baseEvent.type];
  decoded.timestamp = decoded.baseEvent.timestamp;
  decoded.rawEvent = decoded.baseEvent.rawEvent;

  // we want tool calls to be optional, so we need to remove them if they are empty
  if (decoded.type === EventType.MESSAGES_SNAPSHOT) {
    for (const message of (decoded as any).messages as Message[]) {
      const untypedMessage = message as any;
      if (untypedMessage.toolCalls?.length === 0) {
        untypedMessage.toolCalls = undefined;
      }
      if (Array.isArray(untypedMessage.contentParts) && untypedMessage.contentParts.length > 0) {
        untypedMessage.content = untypedMessage.contentParts.map(fromProtoContent);
      }
      delete untypedMessage.contentParts;
    }
  }

  // custom mapping for json patch operations
  if (decoded.type === EventType.STATE_DELTA) {
    for (const operation of (decoded as any).delta) {
      operation.op = protoPatch.JsonPatchOperationType[operation.op].toLowerCase();
      Object.keys(operation).forEach((key) => {
        if (operation[key] === undefined) {
          delete operation[key];
        }
      });
    }
  }

  Object.keys(decoded).forEach((key) => {
    if (decoded[key] === undefined) {
      delete decoded[key];
    }
  });

  return EventSchemas.parse(decoded);
}
