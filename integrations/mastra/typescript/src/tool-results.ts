import type { ContentPart, PartSource } from "@ag-ui/client";

/**
 * Tool results as content parts, in both directions.
 *
 * Mastra keeps what the model sees of a tool result apart from the raw result:
 * a tool's `toModelOutput` is stored as `providerMetadata.mastra.modelOutput`
 * on the tool-result chunk and on the stored tool invocation, and Mastra's
 * prompt builder sends that value to the model in place of the raw result.
 * Its `content` form (a list of text, media, URL and file-id items) is the one
 * that maps onto AG-UI content parts; the text and json forms do not.
 */

type ModelOutputContentItem =
  | { type: "text"; text: string }
  | { type: "media"; data: string; mediaType: string }
  | { type: "image-url"; url: string }
  | { type: "file-url"; url: string }
  | {
      type: "file-id" | "image-file-id";
      fileId: string | Record<string, string>;
    };

export interface MastraContentModelOutput {
  type: "content";
  value: ModelOutputContentItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mediaPartType(
  mimeType: string | undefined,
): "image" | "audio" | "video" | "document" {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("audio/")) return "audio";
  if (mimeType?.startsWith("video/")) return "video";
  return "document";
}

const DATA_URI = /^data:([^,]*),([\s\S]*)$/i;
// Base64 has no colon, so a scheme prefix marks a URL.
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const PERCENT_ESCAPE = /%([0-9a-f]{2})/gi;

/** A data URI's percent-encoded payload (RFC 2397) as base64. */
function percentEncodedToBase64(payload: string): string {
  let binary = "";
  for (const piece of payload.split(/(%[0-9a-f]{2})/i)) {
    if (/^%[0-9a-f]{2}$/i.test(piece)) {
      binary += String.fromCharCode(parseInt(piece.slice(1), 16));
    } else {
      for (const byte of new TextEncoder().encode(piece)) {
        binary += String.fromCharCode(byte);
      }
    }
  }
  return btoa(binary);
}

/**
 * Where a model-output media item's bytes are. Mastra normalizes an AI SDK
 * `image-url` item into `media` with the URL as its data, so a data URI or a
 * URL can arrive where base64 is declared. A data URI's own type wins, and an
 * omitted one is text/plain (RFC 2397).
 */
function mediaSource(data: string, mediaType: string | undefined): PartSource {
  const dataUri = DATA_URI.exec(data);
  if (dataUri) {
    const [uriType, ...params] = dataUri[1].split(";");
    const payload = dataUri[2];
    const isBase64 = params.at(-1)?.trim().toLowerCase() === "base64";
    return {
      type: "data",
      value: isBase64
        ? payload
            .replace(PERCENT_ESCAPE, (_, hex: string) =>
              String.fromCharCode(parseInt(hex, 16)),
            )
            .replace(/\s+/g, "")
        : percentEncodedToBase64(payload),
      mimeType: uriType.trim() || mediaType || "text/plain",
    };
  }
  if (URL_SCHEME.test(data)) {
    return {
      type: "url",
      value: data,
      ...(mediaType ? { mimeType: mediaType } : {}),
    };
  }
  return {
    type: "data",
    value: data,
    mimeType: mediaType ?? "application/octet-stream",
  };
}

function mediaPart(source: PartSource, filename?: unknown): ContentPart {
  return {
    type: mediaPartType(source.mimeType),
    source,
    ...(typeof filename === "string" && filename !== ""
      ? { metadata: { filename } }
      : {}),
  } as ContentPart;
}

function fileHandle(fileId: unknown): PartSource | undefined {
  if (typeof fileId === "string" && fileId !== "") {
    return { type: "file", value: fileId };
  }
  if (isRecord(fileId)) {
    const entries = Object.entries(fileId);
    if (entries.length === 1 && typeof entries[0][1] === "string") {
      return { type: "file", value: entries[0][1], provider: entries[0][0] };
    }
  }
  return undefined;
}

function modelOutputItemToPart(item: unknown): ContentPart | undefined {
  if (!isRecord(item)) return undefined;
  switch (item.type) {
    case "text":
      return typeof item.text === "string"
        ? { type: "text", text: item.text }
        : undefined;
    // AI SDK v5 media, and the v6 data forms.
    case "media":
    case "image-data":
    case "file-data": {
      if (typeof item.data !== "string") return undefined;
      const mediaType =
        typeof item.mediaType === "string" && item.mediaType !== ""
          ? item.mediaType
          : undefined;
      const part = mediaPart(mediaSource(item.data, mediaType), item.filename);
      return item.type === "image-data"
        ? ({ ...part, type: "image" } as ContentPart)
        : part;
    }
    case "image-url":
    case "file-url": {
      if (typeof item.url !== "string") return undefined;
      const mimeType =
        typeof item.mediaType === "string" ? item.mediaType : undefined;
      if (item.type === "image-url") {
        return {
          type: "image",
          source: {
            type: "url",
            value: item.url,
            ...(mimeType ? { mimeType } : {}),
          },
        };
      }
      return mediaPart({
        type: "url",
        value: item.url,
        ...(mimeType ? { mimeType } : {}),
      });
    }
    case "image-file-id":
    case "file-id": {
      const source = fileHandle(item.fileId);
      if (!source) return undefined;
      return item.type === "image-file-id"
        ? { type: "image", source }
        : { type: "document", source };
    }
    default:
      return undefined;
  }
}

/**
 * The content parts of a tool's model output, or undefined when the output is
 * not the content form, or none of its items maps onto a part.
 */
export function modelOutputToContentParts(
  modelOutput: unknown,
): ContentPart[] | undefined {
  if (
    !isRecord(modelOutput) ||
    modelOutput.type !== "content" ||
    !Array.isArray(modelOutput.value)
  ) {
    return undefined;
  }
  const parts = modelOutput.value
    .map(modelOutputItemToPart)
    .filter((part): part is ContentPart => part !== undefined);
  return parts.length > 0 ? parts : undefined;
}

/** The model output a tool-result chunk carries, if any. */
export function readModelOutput(providerMetadata: unknown): unknown {
  if (!isRecord(providerMetadata) || !isRecord(providerMetadata.mastra)) {
    return undefined;
  }
  return providerMetadata.mastra.modelOutput;
}

/**
 * The message of a `tool-error` chunk's error. Locally it is the thrown value;
 * over the remote stream it arrives serialized, so an object without a
 * `message` is shown as JSON rather than "[object Object]".
 */
export function toolErrorMessage(error: unknown): string {
  if (typeof error === "string" && error) return error;
  if (isRecord(error) && typeof error.message === "string" && error.message) {
    return error.message;
  }
  if (error == null || error === "") return "Unknown error";
  if (error instanceof Error) return String(error);
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * TOOL_CALL_RESULT content: the model output's parts when the tool produced
 * the content form, otherwise the raw result serialized as before.
 */
export function toolResultContent(
  result: unknown,
  modelOutput: unknown,
): string | ContentPart[] {
  return modelOutputToContentParts(modelOutput) ?? serializeResult(result);
}

/**
 * The raw result as a string, since content is required. A result JSON has no
 * text for (undefined, a function) is the empty string, and one JSON rejects
 * (a BigInt, a cycle) falls back to its string form with a warning.
 */
function serializeResult(result: unknown): string {
  try {
    return JSON.stringify(result) ?? "";
  } catch (error) {
    console.warn(
      `[MastraAgent] Tool result is not JSON-serializable; sending its string form: ${String(error)}`,
    );
    return String(result);
  }
}

/**
 * A media part's source as a model output item, or why it cannot be one.
 * Bytes are `media` with their type. A URL is never `media`, whose data a
 * provider sends as base64: an image URL (an image type, or an untyped image
 * part) is `image-url` and any other is `file-url`, and a data URI is read as
 * the bytes it holds. A provider handle is `file-id` or `image-file-id`.
 */
function sourceToModelOutputItem(
  partType: string,
  source: PartSource,
): ModelOutputContentItem | { dropped: string } {
  // Client input: the schema's types are not guaranteed at runtime.
  const value: unknown = source.value;
  const mimeType: unknown = source.mimeType;
  switch (source.type) {
    case "data":
      if (typeof value !== "string") {
        return { dropped: "a data source without a string value" };
      }
      if (typeof mimeType !== "string" || mimeType === "") {
        return { dropped: "a data source without a mimeType" };
      }
      return { type: "media", data: value, mediaType: mimeType };
    case "url": {
      if (typeof value !== "string") {
        return { dropped: "a url source without a string value" };
      }
      const declared =
        typeof mimeType === "string" && mimeType !== "" ? mimeType : undefined;
      if (DATA_URI.test(value)) {
        return sourceToModelOutputItem(partType, mediaSource(value, declared));
      }
      const isImage = declared
        ? declared.startsWith("image/")
        : partType === "image";
      return isImage
        ? { type: "image-url", url: value }
        : { type: "file-url", url: value };
    }
    case "file":
      return {
        type: partType === "image" ? "image-file-id" : "file-id",
        fileId: source.provider
          ? { [source.provider]: source.value }
          : source.value,
      };
    default:
      return {
        dropped: `a ${String((source as { type?: unknown }).type)} source`,
      };
  }
}

/**
 * A tool message's content parts as the model output Mastra sends in place of
 * the result. A part with no source, or one whose source cannot be an item
 * (an unknown source type, or data without a string value or a mimeType), is
 * dropped with a warning. A result left with nothing is answered with the
 * empty string, since a call without an answer is one most models reject.
 */
export function contentPartsToModelOutput(
  parts: ContentPart[],
): MastraContentModelOutput | { type: "text"; value: string } {
  const value: ModelOutputContentItem[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      value.push({ type: "text", text: part.text });
      continue;
    }
    // Message content is client input, so a part may arrive without a source.
    if (!isRecord(part.source)) {
      console.warn(
        `[convertAGUIMessagesToMastra] Dropping ${part.type} tool result content: it has no source`,
      );
      continue;
    }
    const item = sourceToModelOutputItem(part.type, part.source);
    if ("dropped" in item) {
      console.warn(
        `[convertAGUIMessagesToMastra] Dropping ${part.type} tool result content: ${item.dropped} cannot be forwarded in a tool result by this adapter`,
      );
      continue;
    }
    value.push(item);
  }
  return value.length > 0
    ? { type: "content", value }
    : { type: "text", value: "" };
}
