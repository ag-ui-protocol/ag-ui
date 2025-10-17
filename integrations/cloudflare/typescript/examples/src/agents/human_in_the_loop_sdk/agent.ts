/**
 * Human-in-the-Loop Agent with requiresApproval
 *
 * Demonstrates proper HITL implementation using Cloudflare Agents SDK pattern
 * with requiresApproval that triggers interrupt events for AG-UI
 */

/**
 * Human-in-the-Loop Agent
 * Simulates Cloudflare Agents SDK with requiresApproval pattern
 */
export class HumanInTheLoopAgent {
  id = "human-in-the-loop-agent";
  private state: Record<string, any> = {};

  async setState(state: Record<string, any>): Promise<void> {
    this.state = { ...this.state, ...state };
  }

  getState(): Record<string, any> {
    return this.state;
  }

  async sql<T = any>(query: TemplateStringsArray, ...values: any[]): Promise<T[]> {
    return [];
  }

  async schedule(when: string | Date | number, callback: string, data?: any): Promise<void> {
    // No-op for example
  }

  /**
   * Handles chat messages with human-in-the-loop approval
   * This simulates the Agents SDK processToolCalls with requiresApproval
   */
  async *onChatMessage(message: string, context: any): AsyncGenerator<any> {
    // Phase 1: Acknowledge the request
    yield "I'll create a plan for that task. Let me break it down into steps.\n\n";

    // Phase 2: Start tool call
    yield {
      type: "tool_call",
      toolCall: {
        id: "hitl-tc-1",
        name: "generate_task_steps",
      }
    };

    // Phase 3: Generate steps based on user message
    const steps = this.generateStepsFromMessage(message);
    const stepsJson = JSON.stringify({ steps });

    // Stream the tool arguments
    for (let i = 0; i < stepsJson.length; i += 20) {
      const chunk = stepsJson.substring(i, i + 20);
      yield {
        type: "tool_call_delta",
        toolCall: {
          id: "hitl-tc-1",
          argsChunk: chunk,
        }
      };
    }

    // Phase 4: Complete tool call with full args
    yield {
      type: "tool_call",
      toolCall: {
        id: "hitl-tc-1",
        name: "generate_task_steps",
        done: true,
        args: { steps }
      }
    };

    // Phase 5: EMIT INTERRUPT for requiresApproval!
    // This is the key part that makes HITL work
    yield {
      type: "interrupt",
      interrupt: {
        name: "requiresApproval",
        value: {
          toolCallId: "hitl-tc-1",
          toolName: "generate_task_steps",
          steps: steps,
          message: "Please review and approve the steps below"
        }
      }
    };

    // Phase 6: After approval (simulated - in real SDK this would wait)
    // In production, the agent would pause here until user approves/rejects
    yield "\n\n✅ Steps approved! I'll proceed with the plan.";
  }

  /**
   * Generate task steps based on user message
   */
  private generateStepsFromMessage(message: string): Array<{description: string, status: string}> {
    // Extract keywords to determine task
    const lowerMessage = message.toLowerCase();

    if (lowerMessage.includes("pasta") || lowerMessage.includes("pastra")) {
      return [
        { description: "Boil water in a large pot", status: "enabled" },
        { description: "Add salt to the boiling water", status: "enabled" },
        { description: "Add pasta and cook for 8-10 minutes", status: "enabled" },
        { description: "Prepare sauce while pasta cooks", status: "enabled" },
        { description: "Drain pasta and mix with sauce", status: "enabled" },
        { description: "Serve hot with garnish", status: "enabled" }
      ];
    } else if (lowerMessage.includes("plan") || lowerMessage.includes("task")) {
      // Generic task planning
      const words = message.split(" ");
      const numSteps = words.find(w => /^\d+$/.test(w));
      const count = numSteps ? parseInt(numSteps) : 5;

      return Array.from({ length: Math.min(count, 10) }, (_, i) => ({
        description: `Step ${i + 1}: Complete task component`,
        status: "enabled"
      }));
    } else {
      // Default steps
      return [
        { description: "Analyze the requirements", status: "enabled" },
        { description: "Create a plan of action", status: "enabled" },
        { description: "Execute the plan", status: "enabled" },
        { description: "Review the results", status: "enabled" },
        { description: "Make final adjustments", status: "enabled" }
      ];
    }
  }

  async onRequest(request: Request): Promise<Response> {
    return new Response("Use AG-UI adapter", { status: 501 });
  }
}

/**
 * Singleton instance
 */
let _hitlAgent: HumanInTheLoopAgent | null = null;

export function getHumanInTheLoopAgent(): HumanInTheLoopAgent {
  if (!_hitlAgent) {
    _hitlAgent = new HumanInTheLoopAgent();
  }
  return _hitlAgent;
}
