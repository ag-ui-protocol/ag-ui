import type { SystemPrompt } from "@strands-agents/sdk";

export type StrandsToolRegistry =
  | {
      registry?: Map<unknown, unknown> | { values(): Iterable<unknown> };
    }
  | undefined;

export type StrandsAgentLike = {
  model?: unknown;
  systemPrompt?: string | SystemPrompt;
  system_prompt?: string | SystemPrompt;
  toolRegistry?: StrandsToolRegistry;
  tools?: Iterable<unknown>;
  recordDirectToolCall?: boolean;
  streamAsync?: (input: string | unknown) => AsyncIterable<unknown>;
  stream?: (input: string | unknown) => AsyncIterable<unknown>;
};

export function extractTools(source: StrandsAgentLike): unknown[] {
  if (source.toolRegistry?.registry) {
    const registry = source.toolRegistry.registry;
    if (registry instanceof Map) {
      return Array.from(registry.values());
    }
    if (typeof registry.values === "function") {
      return Array.from(registry.values());
    }
  }
  if (source.tools) return Array.from(source.tools);
  return [];
}

export function getToolName(
  tool: string | { name?: string; tool_name?: string; [key: string]: unknown }
): string | null {
  if (typeof tool === "string") return tool;
  if (tool?.name) return String(tool.name);
  if (tool?.tool_name) return String(tool.tool_name);
  return null;
}
