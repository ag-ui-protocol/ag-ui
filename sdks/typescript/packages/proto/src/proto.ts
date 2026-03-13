import { BaseEvent, AGUIEvent, EventSchemas, EventType, Message } from "@ag-ui/core";
import * as protoEvents from "./generated/events";
import * as protoPatch from "./generated/patch";

const toProtoSource = (source: any): any => {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  if (source.type === "data") {
    return {
      data: {
        value: source.value,
        mimeType: source.mimeType,
      },
    };
  }

  if (source.type === "url") {
    return {
      url: {
        value: source.value,
        mimeType: source.mimeType,
      },
    };
  }

  return undefined;
};

const toProtoContentPart = (part: any): any => {
  if (!part || typeof part !== "object") {
    return undefined;
  }

  switch (part.type) {
    case "text":
      return {
        text: {
          text: part.text,
        },
      };
    case "image":
      return {
        image: {
          source: toProtoSource(part.source),
          metadata: part.metadata,
        },
      };
    case "audio":
      return {
        audio: {
          source: toProtoSource(part.source),
          metadata: part.metadata,
        },
      };
    case "video":
      return {
        video: {
          source: toProtoSource(part.source),
          metadata: part.metadata,
        },
      };
    case "document":
      return {
        document: {
          source: toProtoSource(part.source),
          metadata: part.metadata,
        },
      };
    case "binary": {
      const source = part.data
        ? { data: { value: part.data, mimeType: part.mimeType } }
        : part.url
          ? { url: { value: part.url, mimeType: part.mimeType } }
          : part.id
            ? { url: { value: part.id, mimeType: part.mimeType } }
            : undefined;

      if (!source) {
        return undefined;
      }

      return {
        document: {
          source,
          metadata: {
            legacyBinary: true,
            filename: part.filename,
            id: part.id,
          },
        },
      };
    }
    default:
      return undefined;
  }
};

const fromProtoSource = (source: any): any => {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  if (source.data) {
    return {
      type: "data",
      value: source.data.value,
      mimeType: source.data.mimeType,
    };
  }

  if (source.url) {
    return {
      type: "url",
      value: source.url.value,
      mimeType: source.url.mimeType,
    };
  }

  return undefined;
};

const fromProtoContentPart = (part: any): any => {
  if (!part || typeof part !== "object") {
    return undefined;
  }

  if (part.text) {
    return {
      type: "text",
      text: part.text.text,
    };
  }

  if (part.image) {
    return {
      type: "image",
      source: fromProtoSource(part.image.source),
      metadata: part.image.metadata,
    };
  }

  if (part.audio) {
    return {
      type: "audio",
      source: fromProtoSource(part.audio.source),
      metadata: part.audio.metadata,
    };
  }

  if (part.video) {
    return {
      type: "video",
      source: fromProtoSource(part.video.source),
      metadata: part.video.metadata,
    };
  }

  if (part.document) {
    return {
      type: "document",
      source: fromProtoSource(part.document.source),
      metadata: part.document.metadata,
    };
  }

  return undefined;
};

function toCamelCase(str: string): string {
  return str.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Encodes an event message to a protocol buffer binary format.
 */
export function encode(event: BaseEvent): Uint8Array {
  /**
   * In previous versions of AG-UI, we didn't really validate the events
   * against a schema. With stronger types for events and Zod schemas, we
   * can now validate.
   *
   * However, I don't want to break compatibility with existing clients
   * even if they are encoding invalid events. This surfaces a warning
   * to them in those situations.
   *
   * @author mikeryandev
   */
  let validatedEvent: AGUIEvent | BaseEvent;
  try {
    validatedEvent = EventSchemas.parse(event) as AGUIEvent;
  } catch (err) {
    console.warn(
      "[ag-ui][proto.encode] Malformed devent detected, falling back to unvalidated event",
      err,
      event,
    );
    validatedEvent = event;
  }
  const oneofField = toCamelCase(validatedEvent.type);
  const { type, timestamp, rawEvent, ...rest } = validatedEvent as AGUIEvent as Record<string, any>;

  // since protobuf does not support optional arrays, we need to ensure that the toolCalls array is always present
  if (type === EventType.MESSAGES_SNAPSHOT && Array.isArray(rest.messages)) {
    rest.messages = (rest.messages as Message[]).map((message) => {
      const untypedMessage = message as any;
      const normalizedMessage: any = { ...untypedMessage, contentParts: [] };

      if (Array.isArray(untypedMessage.content)) {
        const contentParts = untypedMessage.content
          .map((part: any) => toProtoContentPart(part))
          .filter((part: any) => part !== undefined);

        normalizedMessage.contentParts = contentParts;
        normalizedMessage.content = undefined;
      }

      if (untypedMessage.toolCalls === undefined) {
        normalizedMessage.toolCalls = [];
      }

      return normalizedMessage;
    });
  }

  // custom mapping for json patch operations
  if (type === EventType.STATE_DELTA && Array.isArray(rest.delta)) {
    rest.delta = (rest.delta as any[]).map((operation: any) => ({
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
  const event = protoEvents.Event.decode(data);
  const decoded = Object.values(event).find((value) => value !== undefined);
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

      if (untypedMessage.role === "user" && Array.isArray(untypedMessage.contentParts)) {
        const contentParts = untypedMessage.contentParts
          .map((part: any) => fromProtoContentPart(part))
          .filter((part: any) => part !== undefined);

        if (contentParts.length > 0) {
          untypedMessage.content = contentParts;
        }
      }

      if (Array.isArray(untypedMessage.contentParts) && untypedMessage.contentParts.length === 0) {
        untypedMessage.contentParts = undefined;
      }

      if (untypedMessage.toolCalls?.length === 0) {
        untypedMessage.toolCalls = undefined;
      }
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
