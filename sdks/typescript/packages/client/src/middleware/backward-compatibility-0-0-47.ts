import { Middleware } from "./middleware";
import { AbstractAgent } from "@/agent";
import type { RunAgentInput, BaseEvent } from "@ag-ui/core";
import type { Observable } from "rxjs";

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
  source: { type: "data"; value: string; mimeType: string } | { type: "url"; value: string; mimeType: string };
  metadata?: unknown;
}

function mimeTypeToContentType(mimeType: string): "image" | "audio" | "video" | "document" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function isLegacyBinaryContent(part: unknown): part is LegacyBinaryContent {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    (part as { type: unknown }).type === "binary" &&
    "mimeType" in part &&
    typeof (part as { mimeType: unknown }).mimeType === "string"
  );
}

function warnDroppedBinary() {
  if (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    process.env.SUPPRESS_TRANSFORMATION_WARNINGS
  )
    return;
  console.warn(
    "AG-UI dropped a legacy binary content part that only has an `id` (no `data` or `url`). " +
      "The binary content type was removed in 1.0.0 and `id`-only parts have no equivalent in the " +
      "image/audio/video/document model. Re-send it with `source: { type: \"data\" | \"url\", ... }`. " +
      "To suppress this warning, set SUPPRESS_TRANSFORMATION_WARNINGS=true.",
  );
}

// Returns null to signal that the part should be dropped (id-only binary, which
// has no representation in the new data|url source model).
function convertBinaryToNewFormat(binary: LegacyBinaryContent): NewContentPart | null {
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

  warnDroppedBinary();
  return null;
}

function upgradeMessageContent(message: InputMessage): InputMessage {
  const rawContent = (message as { content?: unknown }).content;

  if (!Array.isArray(rawContent)) {
    return message;
  }

  const upgraded = rawContent.reduce<unknown[]>((parts, part: unknown) => {
    if (isLegacyBinaryContent(part)) {
      const converted = convertBinaryToNewFormat(part);
      if (converted !== null) parts.push(converted);
    } else {
      parts.push(part);
    }
    return parts;
  }, []);

  return { ...message, content: upgraded } as InputMessage;
}

/**
 * Upgrades any legacy binary content parts (`type: "binary"`) in a RunAgentInput's
 * messages to the dedicated content types (image/audio/video/document) with a
 * `source` discriminator. Shared by the HTTP transport (applied unconditionally on
 * outgoing input, since the binary type was removed in 1.0.0) and the
 * {@link BackwardCompatibility_0_0_47} middleware.
 *
 * Old format (v0.0.47 and below):
 *   { type: "binary", mimeType: "image/png", data: "base64..." }
 * New format:
 *   { type: "image", source: { type: "data", value: "base64...", mimeType: "image/png" } }
 *
 * Plain string content and non-binary parts pass through unchanged. `id`-only
 * binary parts (no data/url) are dropped with a warning.
 */
export function upgradeLegacyBinaryInput(input: RunAgentInput): RunAgentInput {
  return {
    ...input,
    messages: input.messages.map(upgradeMessageContent),
  };
}

/**
 * Middleware that converts legacy BinaryInputContent entries to the new dedicated
 * content types. The HTTP transport applies the same upgrade unconditionally on
 * outgoing input (see HttpAgent.requestInit); this middleware covers non-HTTP agents.
 */
export class BackwardCompatibility_0_0_47 extends Middleware {
  override run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return this.runNext(upgradeLegacyBinaryInput(input), next);
  }
}
