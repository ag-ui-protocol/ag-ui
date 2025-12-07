import type { AguiEvent } from "./types";

export type StrandsToolUse = {
  name?: string;
  toolUseId?: string;
  tool_use_id?: string;
  input?: unknown;
};

export type StrandsStreamEvent = {
  type?: string;
  data?: unknown;
  output?: unknown;
  delta?: unknown;
  message?: { role?: string; content?: unknown };
  current_tool_use?: StrandsToolUse;
  currentToolUse?: StrandsToolUse;
  event?: Record<string, unknown>;
  complete?: boolean;
  force_stop?: boolean;
  forceStop?: boolean;
  init_event_loop?: boolean;
  start_event_loop?: boolean;
  initEventLoop?: boolean;
  startEventLoop?: boolean;
};

export function toStreamEvent(raw: unknown): StrandsStreamEvent {
  return isRecord(raw) ? (raw as StrandsStreamEvent) : {};
}

export function isUserMessage(
  value: unknown
): value is { role: "user"; content?: unknown } {
  return isRecord(value) && value.role === "user";
}

export function isToolResultItem(value: unknown): value is {
  toolResult: { toolUseId?: string; tool_use_id?: string; content?: unknown };
} {
  if (!isRecord(value)) return false;
  const toolResult = value.toolResult;
  return (
    isRecord(toolResult) &&
    ("toolUseId" in toolResult || "tool_use_id" in toolResult)
  );
}

export function getToolResultText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (isRecord(item) && typeof item.text === "string") {
      return item.text;
    }
  }
  return null;
}

export function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(/'/g, '"'));
    } catch {
      return text;
    }
  }
}

export function isAguiEvent(value: unknown): value is AguiEvent {
  return isRecord(value) && "type" in value;
}

export function extractTextChunk(event: StrandsStreamEvent): string | null {
  const fromData = coercePrimitiveText(event?.data ?? event?.output);
  if (fromData !== null) {
    return fromData;
  }

  if (event?.delta !== undefined) {
    const deltaText = normalizeDeltaText(event.delta);
    if (deltaText !== null) {
      return deltaText;
    }
  }

  if (isRecord(event) && typeof event.type === "string") {
    if ("delta" in event) {
      const fallbackDelta = normalizeDeltaText(event.delta);
      if (fallbackDelta !== null) {
        return fallbackDelta;
      }
    }
  }

  return null;
}

export function isAsyncGenerator(
  value: AsyncIterable<unknown>
): value is AsyncGenerator<unknown, unknown, unknown> {
  return typeof (value as AsyncGenerator).return === "function";
}

function coercePrimitiveText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return null;
}

function normalizeDeltaText(delta: unknown): string | null {
  if (delta === undefined || delta === null) {
    return null;
  }

  if (
    typeof delta === "string" ||
    typeof delta === "number" ||
    typeof delta === "boolean"
  ) {
    return String(delta);
  }

  if (Array.isArray(delta)) {
    const combined = delta
      .map((item) => normalizeDeltaText(item))
      .filter((item): item is string => Boolean(item))
      .join("");
    return combined.length ? combined : null;
  }

  if (!isRecord(delta)) {
    return null;
  }

  const deltaType =
    typeof delta.type === "string" ? (delta.type as string) : undefined;
  if (
    deltaType &&
    deltaType !== "textDelta" &&
    deltaType !== "output_text" &&
    deltaType !== "reasoning_content.delta"
  ) {
    return null;
  }

  if (typeof delta.text === "string") {
    return delta.text;
  }
  if (typeof delta.delta === "string") {
    return delta.delta;
  }
  if (typeof delta.content === "string") {
    return delta.content;
  }
  if (typeof delta.value === "string") {
    return delta.value;
  }
  if (typeof delta.output_text === "string") {
    return delta.output_text;
  }
  if (delta.delta !== undefined) {
    return normalizeDeltaText(delta.delta);
  }
  if (delta.text !== undefined) {
    return normalizeDeltaText(delta.text);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
