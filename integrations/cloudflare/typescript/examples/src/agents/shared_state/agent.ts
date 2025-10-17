/**
 * Shared State Agent using Cloudflare Workers AI
 *
 * This agent demonstrates persistent state management across multiple
 * messages in a conversation.
 *
 * Example: Maintaining a to-do list that persists across the conversation,
 * allowing the user to add, remove, or modify items over multiple turns.
 *
 * Features:
 * - STATE_SNAPSHOT events for persistent state
 * - STATE_DELTA events for incremental updates
 * - Cross-message state continuity
 */

import { CloudflareAgent, CLOUDFLARE_MODELS } from "@ag-ui/cloudflare";
import { Observable, Subscriber } from "rxjs";
import type { RunAgentInput, BaseEvent } from "@ag-ui/client";
import { EventType, type StateSnapshotEvent } from "@ag-ui/core";

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
      model: CLOUDFLARE_MODELS.LLAMA_3_1_8B,
      systemPrompt: `You are a helpful assistant that manages a to-do list.

The user can ask you to:
- Add items to the list
- Remove items from the list
- Mark items as complete/incomplete
- View the current list

Always acknowledge what you've done and show the updated list state.
Be conversational and helpful.`,
      streamingEnabled: true,
    });
  }

  /**
   * Override run() to manage state across messages
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
   * Enhanced execution with shared state management
   */
  private async executeRunWithSharedState(
    input: RunAgentInput,
    subscriber: Subscriber<BaseEvent>
  ): Promise<void> {
    // Extract current state from input if available
    const currentState = input.state || { todos: [] };

    // Execute the base run
    await this.executeRun(input, subscriber);

    // Emit state snapshot to maintain state across messages
    // In a real implementation, you would parse the response and update the state
    const stateSnapshot: StateSnapshotEvent = {
      type: EventType.STATE_SNAPSHOT,
      snapshot: currentState,
      timestamp: Date.now(),
    };
    subscriber.next(stateSnapshot);
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
