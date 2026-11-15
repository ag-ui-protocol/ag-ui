import type { RunAgentInput } from "@ag-ui/core";

type InputMessage = RunAgentInput["messages"][number];

interface LegacyBinaryContent {
  type: "binary";
  mimeType: string;
  id?: string;
  url?: string;
  data?: string;
  filename?: string;
}

interface NewContentPart {
  type: "image" | "audio" | "video" | "document";
  source:
    | { type: "data"; value: string; mimeType: string }
    | { type: "url"; value: string; mimeType: string };
  metadata?: unknown;
}

function mimeTypeToContentType(mimeType: string): "image" | "audio" | "video" | "document" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

export function isLegacyBinaryContent(part: unknown): part is LegacyBinaryContent {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    (part as { type: unknown }).type === "binary" &&
    "mimeType" in part &&
    typeof (part as { mimeType: unknown }).mimeType === "string"
  );
}

export function convertBinaryToNewFormat(
  binary: LegacyBinaryContent,
): NewContentPart | LegacyBinaryContent {
  const contentType = mimeTypeToContentType(binary.mimeType);

  if (binary.data) {
    return {
      type: contentType,
      source: { type: "data", value: binary.data, mimeType: binary.mimeType },
      ...(binary.filename ? { metadata: { filename: binary.filename } } : {}),
    };
  }

  if (binary.url) {
    return {
      type: contentType,
      source: { type: "url", value: binary.url, mimeType: binary.mimeType },
      ...(binary.filename ? { metadata: { filename: binary.filename } } : {}),
    };
  }

  // If only `id` is present, we can't map to the new source format. The part
  // stays in its legacy shape — which the 1.0 contract no longer accepts —
  // so losing it downstream must not be silent.
  if (
    typeof process === "undefined" ||
    typeof process.env === "undefined" ||
    !process.env.SUPPRESS_TRANSFORMATION_WARNINGS
  ) {
    console.warn(
      `[ag-ui][compat] A binary content part carries only an id ('${binary.id ?? ""}') and cannot be converted to a modern media part; a 1.0 peer will not accept it. Provide data or a url. See the repo-root DEPRECATIONS.md.`,
    );
  }
  return binary;
}

function matchesModernPart(
  part: unknown,
  converted: NewContentPart,
  filename: string | undefined,
): boolean {
  if (typeof part !== "object" || part === null || !("type" in part)) return false;
  if (part.type !== converted.type || !("source" in part)) return false;
  const source = part.source;
  if (typeof source !== "object" || source === null) return false;
  if (
    !("type" in source) ||
    source.type !== converted.source.type ||
    !("value" in source) ||
    source.value !== converted.source.value ||
    !("mimeType" in source) ||
    source.mimeType !== converted.source.mimeType
  )
    return false;
  // A legacy filename is data too: only discard it if the modern part retains it.
  return (
    !filename ||
    ("metadata" in part &&
      typeof part.metadata === "object" &&
      part.metadata !== null &&
      "filename" in part.metadata &&
      part.metadata.filename === filename)
  );
}

export function upgradeMessageContent(message: InputMessage): InputMessage {
  const rawContent = (message as { content?: unknown }).content;

  if (!Array.isArray(rawContent)) {
    return message;
  }

  const upgraded = rawContent.flatMap((part: unknown) => {
    if (isLegacyBinaryContent(part)) {
      const converted = convertBinaryToNewFormat(part);
      // Match against ORIGINAL modern parts, so repeated modern or legacy-only
      // attachments remain intentional repeats. A mirror can precede its original.
      if (
        converted.type !== "binary" &&
        rawContent.some((other: unknown) => matchesModernPart(other, converted, part.filename))
      )
        return [];
      return [converted];
    }
    return [part];
  });

  return { ...message, content: upgraded } as InputMessage;
}
