/**
 * Shared State Agent using Cloudflare Workers AI
 *
 * This agent demonstrates persistent state management across multiple
 * messages in a conversation using tool-based state updates.
 *
 * Example: Maintaining a to-do list that persists across the conversation,
 * allowing the user to add, remove, or modify items over multiple turns.
 *
 * Features:
 * - STATE_SNAPSHOT events for persistent state
 * - Tool-based state mutations (more reliable than regex parsing)
 * - Cross-message state continuity
 */

import { CloudflareAgent, CLOUDFLARE_MODELS } from "@ag-ui/cloudflare";
import { Observable, Subscriber } from "rxjs";
import type { RunAgentInput, BaseEvent } from "@ag-ui/client";
import {
  EventType,
  type StateSnapshotEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
} from "@ag-ui/core";
import { validateTodoItem, sanitizeString } from "../../utils/validation.js";

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
}

interface TodoState {
  todos: TodoItem[];
}

/**
 * Shared State Agent
 *
 * Maintains a shared to-do list state that persists across the conversation.
 * Users can ask to add, remove, or modify items in the list.
 */
export class SharedStateAgent extends CloudflareAgent {
  constructor() {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      throw new Error(
        "Missing required environment variables: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN"
      );
    }

    super({
      accountId,
      apiToken,
      model: CLOUDFLARE_MODELS.LLAMA_3_3_70B_FP8, // Using function-calling capable model
      systemPrompt: `You are a helpful assistant that manages a to-do list. Use the provided tools (add_todo, remove_todo, toggle_todo, list_todos, clear_todos) to handle user requests. After using a tool, acknowledge what you've done.`,
      streamingEnabled: true,
    });
  }

  /**
   * Override run() to manage state across messages using tool calls
   */
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      this.executeRunWithSharedState(input, subscriber)
        .catch((error) => {
          console.error("SharedStateAgent execution error:", error);
          subscriber.error(error);
        })
        .finally(() => {
          subscriber.complete();
        });
    });
  }

  /**
   * Enhanced execution with tool-based state management
   * Listens for tool calls and updates state accordingly
   */
  private async executeRunWithSharedState(
    input: RunAgentInput,
    subscriber: Subscriber<BaseEvent>
  ): Promise<void> {
    // Extract current state from input if available
    const currentState: TodoState = (input.state as TodoState) || { todos: [] };
    let updatedState: TodoState = { todos: [...currentState.todos] };

    // Track current tool call
    let currentToolCall: { name: string; args: any } | null = null;

    // Create custom subscriber to intercept tool calls
    const customSubscriber = {
      next: (event: BaseEvent) => {
        // Pass through all events
        subscriber.next(event);

        // Track tool call start
        if (event.type === EventType.TOOL_CALL_START) {
          const toolCallStart = event as ToolCallStartEvent;
          currentToolCall = { name: toolCallStart.toolCallName, args: {} };
        }

        // Accumulate tool call arguments
        if (event.type === EventType.TOOL_CALL_ARGS && currentToolCall) {
          const argsEvent = event as ToolCallArgsEvent;
          try {
            const parsedArgs = JSON.parse(argsEvent.delta);
            currentToolCall.args = { ...currentToolCall.args, ...parsedArgs };
          } catch {
            // If delta is partial JSON, store it and wait for more
            currentToolCall.args = argsEvent.delta;
          }
        }

        // Execute tool and update state when tool call ends
        if (event.type === EventType.TOOL_CALL_END && currentToolCall) {
          updatedState = this.executeToolCall(
            currentToolCall.name,
            currentToolCall.args,
            updatedState
          );

          // Emit updated state snapshot
          const stateSnapshot: StateSnapshotEvent = {
            type: EventType.STATE_SNAPSHOT,
            snapshot: updatedState,
            timestamp: Date.now(),
          };
          subscriber.next(stateSnapshot);

          currentToolCall = null;
        }
      },
      error: (error: Error) => {
        console.error("SharedStateAgent execution error:", {
          agent: "shared_state",
          threadId: input.threadId,
          runId: input.runId,
          currentState,
          error: {
            message: error.message,
            stack: error.stack,
            name: error.name,
          },
        });
        subscriber.error(error);
      },
      complete: () => {
        // Emit final state even if no tool calls
        if (updatedState.todos.length !== currentState.todos.length ||
            JSON.stringify(updatedState) !== JSON.stringify(currentState)) {
          const stateSnapshot: StateSnapshotEvent = {
            type: EventType.STATE_SNAPSHOT,
            snapshot: updatedState,
            timestamp: Date.now(),
          };
          subscriber.next(stateSnapshot);
        }
      },
    };

    // Execute with custom subscriber
    await this.executeRun(input, customSubscriber as Subscriber<BaseEvent>);
  }

  /**
   * Execute a tool call and return updated state with validation
   * Handles: add_todo, remove_todo, toggle_todo, list_todos, clear_todos
   */
  private executeToolCall(toolName: string, args: any, currentState: TodoState): TodoState {
    const todos = [...currentState.todos];

    switch (toolName) {
      case "add_todo": {
        const { text } = args;
        if (!text) {
          console.warn("add_todo called without text parameter");
          break;
        }

        // Validate and sanitize the todo text
        const validation = validateTodoItem(text);
        if (!validation.valid) {
          console.warn(`Invalid todo text: ${validation.error}`);
          break;
        }

        // Check for duplicates
        const isDuplicate = todos.some(
          (t) => t.text.toLowerCase() === validation.sanitized.toLowerCase()
        );
        if (isDuplicate) {
          console.warn(`Duplicate todo: "${validation.sanitized}"`);
          break;
        }

        const newTodo: TodoItem = {
          id: `todo-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          text: validation.sanitized,
          completed: false,
          createdAt: Date.now(),
        };
        todos.push(newTodo);
        break;
      }

      case "remove_todo": {
        const { text } = args;
        if (!text || typeof text !== "string") {
          console.warn("remove_todo called without valid text parameter");
          break;
        }

        const searchText = sanitizeString(text).toLowerCase();
        if (searchText.length === 0) {
          console.warn("remove_todo called with empty text");
          break;
        }

        const index = todos.findIndex((t) =>
          t.text.toLowerCase().includes(searchText)
        );
        if (index !== -1) {
          todos.splice(index, 1);
        } else {
          console.warn(`Todo not found for removal: "${text}"`);
        }
        break;
      }

      case "toggle_todo": {
        const { text, completed } = args;
        if (!text || typeof text !== "string") {
          console.warn("toggle_todo called without valid text parameter");
          break;
        }

        if (typeof completed !== "boolean") {
          console.warn("toggle_todo called without valid completed parameter");
          break;
        }

        const searchText = sanitizeString(text).toLowerCase();
        const todo = todos.find((t) => t.text.toLowerCase().includes(searchText));
        if (todo) {
          todo.completed = completed;
        } else {
          console.warn(`Todo not found for toggle: "${text}"`);
        }
        break;
      }

      case "list_todos": {
        // list_todos doesn't modify state, just returns it
        // The AI will use the state to respond to the user
        const { filter } = args;
        if (filter && !["completed", "incomplete", "all"].includes(filter)) {
          console.warn(`Invalid filter: "${filter}". Must be: completed, incomplete, or all`);
        }
        break;
      }

      case "clear_todos": {
        const { clearAll } = args;
        if (typeof clearAll !== "boolean" && clearAll !== undefined) {
          console.warn("clear_todos called with invalid clearAll parameter");
          break;
        }

        if (clearAll) {
          todos.length = 0; // Clear all
        } else {
          // Remove only completed
          for (let i = todos.length - 1; i >= 0; i--) {
            if (todos[i].completed) {
              todos.splice(i, 1);
            }
          }
        }
        break;
      }

      default:
        console.warn(`Unknown tool: ${toolName}`);
    }

    return { todos };
  }
}

// Lazy singleton
let _sharedStateAgent: SharedStateAgent | null = null;

export function getSharedStateAgent(): SharedStateAgent {
  if (!_sharedStateAgent) {
    _sharedStateAgent = new SharedStateAgent();
  }
  return _sharedStateAgent;
}
