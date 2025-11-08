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
  EventType,
} from '@ag-ui/client';
import type {
  SDKMessage,
  SDKAssistantMessage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ProcessedEvents,
} from './types';
import {
  hasContentProperty,
  isTextBlock,
  isToolUseBlock,
  isToolResultBlock,
} from './types';

/**
 * EventTranslator converts Claude SDK messages to AG-UI protocol events
 * 
 * NOTE: This translator only handles SDK message translation.
 * Run lifecycle events (RUN_STARTED, RUN_FINISHED, etc.) and step events
 * are handled by ClaudeAgent.
 */
export class EventTranslator {
  private messageIdCounter = 0;
  private currentMessageId: string | null = null;
  private runId: string;
  private threadId: string;

  constructor(runId: string, threadId: string) {
    this.runId = runId;
    this.threadId = threadId;
  }

  /**
   * Translate a Claude SDK message to AG-UI events
   * NOTE: Does not emit RUN_STARTED, RUN_FINISHED, or STEP events - those are handled by ClaudeAgent
   */
  translateMessage(message: SDKMessage): ProcessedEvents[] {
    const events: ProcessedEvents[] = [];

    if (hasContentProperty(message)) {
      events.push(...this.translateAssistantMessage(message as SDKAssistantMessage));
    }
    // Note: ResultMessage (success/error) is ignored here
    // Run completion is handled by ClaudeAgent, not EventTranslator

    return events;
  }

  /**
   * Translate an AssistantMessage with content blocks
   */
  private translateAssistantMessage(message: SDKAssistantMessage): ProcessedEvents[] {
    const events: ProcessedEvents[] = [];

    // Content is in message.message.content for SDKAssistantMessage
    const content = message.message?.content || [];
    
    for (const block of content) {
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
   * NOTE: Step events are handled by ClaudeAgent, not here
   */
  private translateTextBlock(block: TextBlock): ProcessedEvents[] {
    const events: ProcessedEvents[] = [];
    const messageId = this.generateMessageId();

    // Start event
    events.push({
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: 'assistant',
    });

    // Content event - split text into delta chunks
    const text = block.text;
    if (text.length > 0) {
      events.push({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: text,
      });
    }

    // End event
    events.push({
      type: EventType.TEXT_MESSAGE_END,
      messageId,
    });

    return events;
  }

  /**
   * Translate a ToolUseBlock to tool call events
   * NOTE: Step events are handled by ClaudeAgent, not here
   */
  private translateToolUseBlock(block: ToolUseBlock): ProcessedEvents[] {
    const events: ProcessedEvents[] = [];
    const toolCallId = block.id;

    // Start event
    events.push({
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: block.name,
    });

    // Args event - send args as JSON string
    const argsJson = JSON.stringify(block.input);
    if (argsJson.length > 0) {
      events.push({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: argsJson,
      });
    }

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

    const messageId = this.generateMessageId();
    events.push({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: block.tool_use_id,
      messageId,
      content: resultContent,
      ...(block.is_error && { role: 'tool' as const }),
    });

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

