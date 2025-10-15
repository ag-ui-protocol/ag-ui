import { AbstractAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { Observable, Subscriber } from "rxjs";
import { CloudflareAGUIAdapter } from "./adapter";
import type { CloudflareAIConfig } from "./types";

/**
 * Local Cloudflare agent that runs in-process (no HTTP server required)
 * Use this for the dojo or other in-process scenarios
 */
export class CloudflareLocalAgent extends AbstractAgent {
  private adapter: CloudflareAGUIAdapter;

  constructor(config: CloudflareAIConfig) {
    super({});
    this.adapter = new CloudflareAGUIAdapter(config);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber: Subscriber<BaseEvent>) => {
      const execute = async () => {
        try {
          // Convert AG-UI client messages to adapter format
          const messages = input.messages.map((msg) => ({
            role: msg.role as "user" | "assistant" | "system",
            content: msg.content || "",
          }));

          // Execute the adapter and stream events
          for await (const event of this.adapter.execute(messages, input.context)) {
            // Forward adapter events as client events
            subscriber.next({
              ...event,
              threadId: input.threadId,
              runId: input.runId,
            } as BaseEvent);
          }

          subscriber.complete();
        } catch (error) {
          subscriber.error(error);
        }
      };

      execute();
    });
  }
}
