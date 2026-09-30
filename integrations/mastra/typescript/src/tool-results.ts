import type { ContentPart, PartSource } from "@ag-ui/client";

/**
 * Tool results as content parts, in both directions.
 *
 * Mastra keeps what the model sees of a tool result apart from the raw result:
 * a tool's `toModelOutput` is stored as `providerMetadata.mastra.modelOutput`
 * on the tool-result chunk and on the stored tool invocation, and Mastra's
 * prompt builder sends that value to the model in place of the raw result.
 * Its `content` form (text and media items) is the one that maps onto AG-UI
 * content parts.
 */

type ModelOutputContentItem =
  | { type: "text"; text: string }
  | { type: "media"; data: string; mediaType: string };

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

const DATA_URI = /^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]*)$/;
const HTTP_URL = /^https?:\/\//i;

/**
 * Where a model-output media item's bytes are. Mastra normalizes an AI SDK
 * `image-url` item into `media` with the URL as its data, so a data URI or an
 * http(s) URL can arrive where base64 is declared.
 */
function mediaSource(data: string, mediaType: string): PartSource {
  const dataUri = DATA_URI.exec(data);
  if (dataUri) {
    return {
      type: "data",
      value: dataUri[2],
      mimeType: dataUri[1] ?? mediaType,
    };
  }
  if (HTTP_URL.test(data)) {
    return { type: "url", value: data, mimeType: mediaType };
  }
  return { type: "data", value: data, mimeType: mediaType };
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
          : "application/octet-stream";
      return mediaPart(mediaSource(item.data, mediaType), item.filename);
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
 * TOOL_CALL_RESULT content: the model output's parts when the tool produced
 * the content form, otherwise the raw result serialized as before.
 */
export function toolResultContent(
  result: unknown,
  modelOutput: unknown,
): string | ContentPart[] {
  return modelOutputToContentParts(modelOutput) ?? JSON.stringify(result);
}

/**
 * A tool message's content parts as the model output Mastra sends in place of
 * the result. Parts Mastra's stored model output cannot express are dropped
 * with a warning: a URL (its media items carry bytes) and a provider file
 * handle. A result left with nothing is answered with the empty string, since
 * a call without an answer is one most models reject.
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
    if (part.source.type === "data") {
      value.push({
        type: "media",
        data: part.source.value,
        mediaType: part.source.mimeType,
      });
      continue;
    }
    console.warn(
      `[convertAGUIMessagesToMastra] Dropping ${part.type} tool result content: a ${part.source.type} source cannot be forwarded in a tool result by this adapter`,
    );
  }
  return value.length > 0
    ? { type: "content", value }
    : { type: "text", value: "" };
}
