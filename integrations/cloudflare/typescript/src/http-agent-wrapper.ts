import { HttpAgent } from "@ag-ui/client";
import { RunAgentInput, BaseEvent } from "@ag-ui/core";
import { Observable } from "rxjs";
import { v4 as uuidv4 } from "uuid";

/**
 * Wrapper for HttpAgent that ensures threadId is always present
 * This fixes CopilotKit compatibility issues where threadId might be undefined
 */
export class CloudflareHttpAgentWrapper extends HttpAgent {
  run(input: any): Observable<BaseEvent> {
    // Ensure threadId is always present BEFORE validation
    const safeInput: RunAgentInput = {
      threadId: input?.threadId || `thread-${uuidv4()}`,
      runId: input?.runId || `run-${uuidv4()}`,
      state: input?.state || {},
      messages: input?.messages || [],
      tools: input?.tools || [],
      context: input?.context || [],
      forwardedProps: input?.forwardedProps || {},
    };

    return super.run(safeInput);
  }

  // Override runAgent as well to catch it at a higher level
  async runAgent(parameters?: any, subscriber?: any): Promise<any> {
    if (parameters && !parameters.threadId) {
      parameters.threadId = `thread-${uuidv4()}`;
    }

    return super.runAgent(parameters, subscriber);
  }
}
