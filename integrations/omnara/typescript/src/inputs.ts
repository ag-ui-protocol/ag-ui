import type { RunAgentInput, UserMessage } from "@ag-ui/core";
import { parse as parseYaml } from "yaml";
import type { CreateAgentInputContentBlock } from "./api";

// What the adapter sends to Omnara besides API calls: the tool definitions in a
// derived agent config, and a user message as Omnara content blocks.

export function parseSource(config: {
  source?: string;
}): Record<string, unknown> {
  const parsed = config.source ? parseYaml(config.source) : {};
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : {};
}

export function customToolNames(definition: Record<string, unknown>): string[] {
  const tools =
    (definition.tools as Record<string, { type?: string } | null>) ?? {};
  return Object.entries(tools)
    .filter(([, t]) => t?.type === "custom")
    .map(([name]) => name);
}

export function customTool(
  name: string,
  description: string | undefined,
  parameters: unknown,
) {
  return {
    type: "custom",
    // Omnara requires a description; a tool without one is described by its name.
    description: description?.trim() || name,
    input_schema: parameters ?? { type: "object", properties: {} },
  };
}

export function pickToolShape(
  tools: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      const tool = t as { description?: string; input_schema?: unknown };
      return [
        name,
        {
          type: "custom",
          description: tool.description,
          input_schema: tool.input_schema,
        },
      ];
    }),
  );
}

/** JSON with sorted keys, for comparing tool definitions. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

export function messageText(
  content: string | ReadonlyArray<{ type: string; text?: string }>,
): string {
  return typeof content === "string"
    ? content
    : content.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");
}

export function contextBlock(
  context: RunAgentInput["context"],
): CreateAgentInputContentBlock | undefined {
  if (!context?.length) return undefined;
  return {
    type: "text",
    text: `Context from the app:\n${context.map((c) => `- ${c.description}: ${c.value}`).join("\n")}`,
    metadata: { omnara_hidden: "true" },
  };
}

const note = (text: string): CreateAgentInputContentBlock => ({
  type: "text",
  text,
  metadata: { omnara_hidden: "true" },
});

/** The message as Omnara content blocks; inline images and documents become media. */
export function userBlocks(
  message: UserMessage,
  context: CreateAgentInputContentBlock | undefined,
): { blocks: CreateAgentInputContentBlock[]; media: boolean } {
  const blocks: CreateAgentInputContentBlock[] = [];
  let media = false;
  const parts =
    typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : message.content;
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
    } else if (
      (part.type === "image" || part.type === "document") &&
      part.source.type === "data"
    ) {
      media = true;
      blocks.push({
        type: "media",
        media_type: part.source.mimeType as Extract<
          CreateAgentInputContentBlock,
          { type: "media" }
        >["media_type"],
        data: part.source.value,
      });
    } else {
      blocks.push(
        note(
          `(The user attached a file (${part.type}) that could not be forwarded.)`,
        ),
      );
    }
  }
  if (context) blocks.push(context);
  return { blocks, media };
}

/** Omnara's limit on the content of one submission, inline media aside. */
export const MAX_CONTENT_BYTES = 1024 * 1024;

/**
 * The size Omnara counts against `MAX_CONTENT_BYTES`: the blocks as Go's JSON
 * encodes them, which escapes `<`, `>`, `&`, U+2028 and U+2029 as `\uXXXX`.
 */
export function contentBytes(blocks: ReadonlyArray<{ type: string }>): number {
  return blocks.reduce(
    (n, b) =>
      n +
      (b.type === "media"
        ? 0
        : Buffer.byteLength(
            JSON.stringify(b).replace(/[<>&\u2028\u2029]/g, "\\u0000"),
          )),
    0,
  );
}

export function withoutMedia(
  blocks: CreateAgentInputContentBlock[],
): CreateAgentInputContentBlock[] {
  return blocks.map((b) =>
    b.type === "media"
      ? note("(The user attached a file that Omnara could not accept.)")
      : b,
  );
}
