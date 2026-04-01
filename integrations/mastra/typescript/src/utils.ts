import type { BinaryInputContent, InputContent, Message, UserMessage } from '@ag-ui/client';
import type { MastraMessageV1 } from '@mastra/core/agent/message-list';
import type { CoreAssistantMessage, CoreUserMessage } from '@mastra/core/llm';

// ---------------------------------------------------------------------------
// BUG-1 fix: O(1) tool-name index built in a single pass
// ---------------------------------------------------------------------------

/**
 * Builds a Map<toolCallId, toolName> from assistant messages
 * in a single O(n) pass — fixes the O(n²) nested loop in the original.
 * @param messages AG-UI message history.
 */
export function buildToolNameIndex(messages: Message[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const toolCall of msg.toolCalls ?? []) {
        index.set(toolCall.id, toolCall.function.name);
      }
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// BUG-2 fix: binary content → Mastra ImagePart / FilePart
// ---------------------------------------------------------------------------

/**
 * Converts AG-UI UserMessage content to Mastra UserContent,
 * preserving text parts and mapping binary parts to ImagePart / FilePart.
 * @param content AG-UI user message content.
 */
// CoreUserMessage["content"] = string | Array<TextPart | ImagePart | FilePart>
/** User content array variant used when mapping AG-UI input parts to Mastra parts. */
type MastraUserContentParts = NonNullable<Exclude<CoreUserMessage['content'], string>>;

export function toMastraUserContent(content: UserMessage['content']): CoreUserMessage['content'] {
  if (!content) return '';
  if (typeof content === 'string') return content;

  // After ruling out string and falsy, content is InputContent[]
  const items: InputContent[] = content;
  const mastraParts: MastraUserContentParts = [];

  for (const item of items) {
    if (item.type === 'text') {
      const text = item.text;
      if (text.trim()) {
        mastraParts.push({ type: 'text', text });
      }
    } else if (item.type === 'binary') {
      const binary: BinaryInputContent = item;
      const source: string | URL = binary.url ? new URL(binary.url) : (binary.data ?? '');
      const mime = binary.mimeType ?? 'application/octet-stream';

      if (mime.startsWith('image/')) {
        mastraParts.push({ type: 'image', image: source, mimeType: mime });
      } else {
        const filePart: MastraUserContentParts[number] & { type: 'file' } = {
          type: 'file',
          data: source,
          mimeType: mime,
        };
        if (binary.filename) {
          filePart.filename = binary.filename;
        }
        mastraParts.push(filePart);
      }
    }
  }

  // Return string if there is only a single text part (simplest form)
  if (mastraParts.length === 1 && mastraParts[0].type === 'text') {
    return mastraParts[0].text;
  }

  return mastraParts.length > 0 ? mastraParts : '';
}

/**
 * Extracts plain text from AG-UI content (used for assistant / system messages).
 * @param content Raw textual content.
 */
function toMastraTextContent(content: string | undefined): string {
  return content?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// BUG-3 fix: system / developer roles are now handled
// ---------------------------------------------------------------------------

/**
 * Parses tool call arguments string to a plain object, falling back to empty object on failure.
 * @param rawArguments JSON argument string from AG-UI tool call.
 */
function parseToolCallArgs(rawArguments: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

/**
 * Converts AG-UI messages to MastraMessageV1[], fixing:
 * - BUG-1: single-pass O(n) toolName lookup
 * - BUG-2: binary content preserved
 * - BUG-3: `system` and `developer` roles handled
 * - BUG-13: preserve AG-UI message.id → Mastra deduplicates by id, preventing
 *   re-insertion of history messages on every turn
 * @param messages AG-UI message history.
 */
export function convertAGUIMessagesToMastra(messages: Message[]): MastraMessageV1[] {
  // Single-pass index for tool call id → tool name (BUG-1 fix)
  const toolNameIndex = buildToolNameIndex(messages);

  const result: MastraMessageV1[] = [];

  for (const message of messages) {
    switch (message.role) {
      case 'system':
      case 'developer': {
        const text = toMastraTextContent(message.content);
        if (text) {
          result.push({
            id: message.id,
            role: 'system',
            content: text,
            type: 'text',
            createdAt: new Date(),
          });
        }
        break;
      }

      case 'assistant': {
        const textContent = toMastraTextContent(message.content);
        const toolCalls = message.toolCalls ?? [];

        if (toolCalls.length > 0) {
          // Assistant message with tool calls — content is the full parts array
          const parts: CoreAssistantMessage['content'] = [];
          if (textContent) parts.push({ type: 'text', text: textContent });
          for (const tc of toolCalls) {
            parts.push({
              type: 'tool-call',
              toolCallId: tc.id,
              toolName: tc.function.name,
              args: parseToolCallArgs(tc.function.arguments),
            });
          }
          result.push({
            id: message.id,
            role: 'assistant',
            content: parts,
            type: 'tool-call',
            toolCallIds: toolCalls.map((tc) => tc.id),
            toolNames: toolCalls.map((tc) => tc.function.name),
            toolCallArgs: toolCalls.map((tc) => parseToolCallArgs(tc.function.arguments)),
            createdAt: new Date(),
          });
        } else if (textContent) {
          // Text-only assistant message
          result.push({
            id: message.id,
            role: 'assistant',
            content: textContent,
            type: 'text',
            createdAt: new Date(),
          });
        }
        break;
      }

      case 'user': {
        const converted = toMastraUserContent(message.content);
        result.push({
          id: message.id,
          role: 'user',
          content: converted,
          type: 'text',
          createdAt: new Date(),
        });
        break;
      }

      case 'tool': {
        // BUG-1 fix: O(1) lookup
        const toolName = toolNameIndex.get(message.toolCallId) ?? 'unknown';
        result.push({
          id: message.id,
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: message.toolCallId,
              toolName,
              result: message.content,
            },
          ],
          type: 'tool-result',
          createdAt: new Date(),
        });
        break;
      }

      default:
        // Unknown roles are silently ignored
        break;
    }
  }

  return result;
}
