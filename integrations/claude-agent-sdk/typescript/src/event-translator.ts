/**
 * Event translator: Converts Claude SDK messages to AG-UI events
 */

import {
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  RunFinishedEvent,
  RunErrorEvent,
  EventType,
} from '@ag-ui/client';
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ProcessedEvents,
} from './types';
import {
  isAssistantMessage,
  isResultMessage,
  hasContentProperty,
  isTextBlock,
  isToolUseBlock,
  isToolResultBlock,
} from './types';

/**
 * EventTranslator converts Claude SDK messages to AG-UI protocol events
 */
export class EventTranslator {
  private messageIdCounter = 0;
  private currentMessageId: string | null = null;
  private runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  /**
   * Translate a Claude SDK message to AG-UI events
   */
  translateMessage(message: SDKMessage): ProcessedEvents[] {
    const events: ProcessedEvents[] = [];

    if (hasContentProperty(message)) {
      events.push(...this.translateAssistantMessage(message as SDKAssistantMessage));
    } else if (isResultMessage(message)) {
      events.push(...this.translateResultMessage(message));
    }

    return events;
  }

  /**
   * Translate an AssistantMessage with content blocks
   */
  private translateAssistantMessage(message: SDKAssistantMessage): ProcessedEvents[] {
    const events: ProcessedEvents[] = [];

    for (const block of message.content) {
      if (isTextBlock(block)) {
        events.push(...this.translateTextBlock(block));
      } else if (isToolUseBlock(block)) {
        events.push(...this.translateToolUseBlock(block));
      } else if (isToolResultBlock(block)) {
        events.push(...this.translateToolResultBlock(block));
      }
    }

    return events;
  }

  /**
   * Translate a TextBlock to text message events
   */
  private translateTextBlock(block: TextBlock): ProcessedEvents[] {
    const events: ProcessedEvents[] = [];
    const messageId = this.generateMessageId();

    // Start event
    events.push({
      type: EventType.TEXT_MESSAGE_START,
      messageId,
    });

    // Content event
    events.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      content: block.text,
    });

    // End event
    events.push({
      type: EventType.TEXT_MESSAGE_END,
      messageId,
    });

    return events;
  }

  /**
   * Translate a ToolUseBlock to tool call events
   */
  private translateToolUseBlock(block: ToolUseBlock): ProcessedEvents[] {
    const events: ProcessedEvents[] = [];
    const toolCallId = block.id;

    // Start event
    events.push({
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolName: block.name,
    });

    // Args event - send args as JSON string
    events.push({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      args: JSON.stringify(block.input),
    });

    // End event
    events.push({
      type: EventType.TOOL_CALL_END,
      toolCallId,
    });

    return events;
  }

  /**
   * Translate a ToolResultBlock to tool call result event
   */
  private translateToolResultBlock(block: ToolResultBlock): ProcessedEvents[] {
    const events: ProcessedEvents[] = [];

    // Extract content as string
    let resultContent: string;
    if (typeof block.content === 'string') {
      resultContent = block.content;
    } else if (Array.isArray(block.content)) {
      // Handle array of content blocks
      resultContent = block.content
        .map((item) => {
          if (item.type === 'text') {
            return item.text || '';
          }
          return JSON.stringify(item);
        })
        .join('\n');
    } else {
      resultContent = JSON.stringify(block.content);
    }

    events.push({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: block.tool_use_id,
      result: resultContent,
      isError: block.is_error || false,
    });

    return events;
  }

  /**
   * Translate a ResultMessage to run finished or error event
   */
  private translateResultMessage(message: SDKResultMessage): ProcessedEvents[] {
    const events: ProcessedEvents[] = [];

    if (message.subtype === 'success') {
      events.push({
        type: EventType.RUN_FINISHED,
        runId: this.runId,
      });
    } else if (message.subtype === 'error') {
      events.push({
        type: EventType.RUN_ERROR,
        runId: this.runId,
        error: message.error?.message || 'Unknown error',
      });
    }

    return events;
  }

  /**
   * Generate a unique message ID
   */
  private generateMessageId(): string {
    this.messageIdCounter++;
    return `msg_${this.runId}_${this.messageIdCounter}`;
  }

  /**
   * Reset the translator state for a new execution
   */
  reset(): void {
    this.messageIdCounter = 0;
    this.currentMessageId = null;
  }

  /**
   * Get current message ID
   */
  getCurrentMessageId(): string | null {
    return this.currentMessageId;
  }

  /**
   * Set current message ID
   */
  setCurrentMessageId(messageId: string | null): void {
    this.currentMessageId = messageId;
  }
}

