import { getTextContent, type ChatMessage } from "@copilotkit/aimock";

/** Text-only message content, with absent content normalized for fixture matching. */
export function textOf(content: ChatMessage["content"] | undefined): string {
  return getTextContent(content ?? null) ?? "";
}
