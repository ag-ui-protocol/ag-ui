/** Lossless content conversion. Original filenames/metadata remain in RUN_STARTED.input. */
import type { Message, ContentPart } from "@ag-ui/client";
import type { BetaManagedAgentsUserMessageEventParams } from "@anthropic-ai/sdk/resources/beta/sessions/events";

type Blocks = BetaManagedAgentsUserMessageEventParams["content"];
export const userContent = (
  message: Extract<Message, { role: "user" | "tool" }>,
): Blocks => {
  if (typeof message.content === "string")
    return message.content.trim()
      ? [{ type: "text", text: message.content }]
      : [];
  const blocks: Blocks = [];
  for (const part of message.content ?? []) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type !== "image" && part.type !== "document") continue;
    const mime = part.source.mimeType;
    if (
      mime &&
      !(part.type === "image"
        ? ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)
        : ["application/pdf", "text/plain"].includes(mime))
    )
      continue;
    let source: Exclude<Blocks[number], { type: "text" }>["source"];
    if (
      part.source.type === "file" &&
      (!part.source.provider || part.source.provider === "anthropic")
    )
      source = { type: "file", file_id: part.source.value };
    else if (part.source.type === "url")
      source = { type: "url", url: part.source.value };
    else if (part.source.type === "data")
      source = {
        type: "base64",
        data: part.source.value,
        media_type: part.source.mimeType,
      };
    else continue;
    const filename =
      part.metadata &&
      typeof part.metadata === "object" &&
      "filename" in part.metadata &&
      typeof part.metadata.filename === "string"
        ? part.metadata.filename
        : undefined;
    blocks.push(
      part.type === "image"
        ? { type: "image", source }
        : {
            type: "document",
            source:
              source.type === "base64" && mime === "text/plain"
                ? {
                    type: "text",
                    data: new TextDecoder("utf-8", {
                      fatal: true,
                      ignoreBOM: true,
                    }).decode(
                      Uint8Array.from(atob(source.data), (char) =>
                        char.charCodeAt(0),
                      ),
                    ),
                    media_type: "text/plain",
                  }
                : source,
            ...(filename ? { title: filename } : {}),
          },
    );
  }
  return message.role === "tool" ||
    blocks.some((block) => block.type !== "text" || block.text.trim())
    ? blocks
    : [];
};

/** Preserve native rich blocks in standard AG-UI parts; RAW carries the exact event. */
export const toolContent = (
  blocks: ReadonlyArray<{ type: string; text?: string }> | null | undefined,
  isError = false,
): string | ContentPart[] => {
  const content = blocks ?? [];
  if (
    content.every(
      (b) =>
        b.type === "text" &&
        typeof b.text === "string" &&
        Object.keys(b).every((k) => k === "type" || k === "text"),
    )
  ) {
    const text = content.map((b) => b.text).join("\n");
    return isError ? JSON.stringify({ error: true, content: text }) : text;
  }
  return content.map((block): ContentPart => {
    const b = block as Record<string, any>;
    if (b.type === "text" && typeof b.text === "string")
      return {
        type: "text",
        text: b.text,
        metadata: {
          claudeManagedAgents: b,
          ...(isError ? { isError: true } : {}),
        },
      };
    if ((b.type === "image" || b.type === "document") && b.source) {
      const s = b.source;
      const source =
        s.type === "base64"
          ? { type: "data" as const, value: s.data, mimeType: s.media_type }
          : s.type === "url"
            ? { type: "url" as const, value: s.url }
            : s.type === "file"
              ? {
                  type: "file" as const,
                  value: s.file_id,
                  provider: "anthropic",
                }
              : undefined;
      if (source)
        return {
          type: b.type,
          source,
          metadata: {
            claudeManagedAgents: b,
            ...(isError ? { isError: true } : {}),
          },
        };
    }
    // Unknown/native-only block shapes stay visible and recoverable, never a label.
    return {
      type: "text",
      text: JSON.stringify(b),
      metadata: {
        claudeManagedAgents: b,
        ...(isError ? { isError: true } : {}),
      },
    };
  });
};
