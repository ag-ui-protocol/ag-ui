import {
  AbstractAgent,
  AgentConfig,
  BaseEvent,
  EventType,
  RunAgentInput,
  RunErrorEvent,
  StateSnapshotEvent,
  TextMessageChunkEvent,
  ToolCallChunkEvent,
  ToolCallResultEvent,
} from "@ag-ui/client";


import { A2AClient } from "@a2a-js/sdk/client";
import {SendMessageResponse, SendMessageSuccessResponse} from "@a2a-js/sdk";
import { Observable } from "rxjs";
import { LanguageModel, processDataStream, streamText, tool } from "ai";
import {
  convertMessagesToVercelAISDKMessages,
  convertToolToVercelAISDKTools,
  createSystemPrompt,
} from "./utils";
import { z } from "zod";
import { randomUUID } from "crypto";
import { ToolCallResultEvent } from "@ag-ui/client";

const toolDefinition = {
  name: 'send_message_to_a2a_agent',
  description: 'Send a message to an A2A agent named `agentName`',
  parameters: z.object({
    agentName: z.string().describe("The name of the agent to send the task to."),
    task: z
      .string()
      .describe(
        "The comprehensive conversation-context summary and goal " +
          "to be achieved regarding the user inquiry.",
      ),
  }),
};

export interface A2AAgentConfig extends AgentConfig {
  agentUrls: string[];
  instructions?: string;
  orchestrationAgent: AbstractAgent;
}

export class A2AMiddlewareAgent extends AbstractAgent {
  agentClients: A2AClient[];
  instructions?: string;
  orchestrationAgent: AbstractAgent

  constructor(config: A2AAgentConfig) {
    super(config);
    this.instructions = config.instructions;
    this.agentClients = config.agentUrls.map((url) => new A2AClient(url));
    this.orchestrationAgent = config.orchestrationAgent;
  }


  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((observer) => {
      let pendingA2ACalls = new Set<string>();
      let isRunComplete = false;

      // Start the orchestration agent run
      const orchestrationStream = this.orchestrationAgent.run(input);

      const subscription = orchestrationStream.subscribe({
        next: (event: BaseEvent) => {
          // Handle tool call start events for send_message_to_a2a_agent
          if (event.type === EventType.TOOL_CALL_START && 
              'toolCallName' in event && 
              event.toolCallName === 'send_message_to_a2a_agent') {
            // Track this as a pending A2A call
            pendingA2ACalls.add(event.toolCallId);
            // Proxy the start event normally
            observer.next(event);
            return;
          }

          // Handle tool call chunk events for send_message_to_a2a_agent
          if (event.type === EventType.TOOL_CALL_CHUNK && 
              'toolCallId' in event && 
              pendingA2ACalls.has(event.toolCallId)) {
            // Proxy chunk events normally
            observer.next(event);
            return;
          }

          // Handle tool call result events for send_message_to_a2a_agent
          if (event.type === EventType.TOOL_CALL_RESULT && 
              'toolCallId' in event && 
              pendingA2ACalls.has(event.toolCallId)) {
            // This is a result for our A2A tool call
            pendingA2ACalls.delete(event.toolCallId);
            
            // Execute the A2A message sending function
            this.executeA2AMessage(event, observer, input).then(() => {
              // After A2A message is sent, re-invoke the orchestration agent
              // by continuing the stream
            }).catch((error) => {
              // Handle A2A error
              observer.next({
                type: EventType.TOOL_CALL_RESULT,
                toolCallId: event.toolCallId,
                messageId: randomUUID(),
                content: `Error sending A2A message: ${error.message}`,
              } as ToolCallResultEvent);
            });
            
            // Don't proxy the original result event
            return;
          }

          // Handle run completion events
          if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
            isRunComplete = true;
            
            // Only pass completion events if no pending A2A calls
            if (pendingA2ACalls.size === 0) {
              observer.next(event);
              observer.complete();
            }
            // If there are pending calls, don't emit completion events yet
            return;
          }

          // Proxy all other events
          observer.next(event);
        },
        error: (error) => {
          observer.error(error);
        },
        complete: () => {
          // Only complete if run is actually finished and no pending calls
          if (isRunComplete && pendingA2ACalls.size === 0) {
            observer.complete();
          }
        }
      });

      // Return cleanup function
      return () => {
        subscription.unsubscribe();
      };
    });
  }

  private async executeA2AMessage(
    toolCallResultEvent: ToolCallResultEvent, 
    observer: any, 
    input: RunAgentInput
  ): Promise<void> {
    try {
      // Parse the tool call arguments from the result
      const args = JSON.parse(toolCallResultEvent.content);
      const { agentName, task } = args;

      // Find the A2A client for this agent
      const agentCards = await Promise.all(
        this.agentClients.map((client) => client.getAgentCard()),
      );

      const agents = Object.fromEntries(
        agentCards.map((card, index) => [
          card.name,
          { client: this.agentClients[index], card },
        ]),
      );

      if (!agents[agentName]) {
        throw new Error(`Agent "${agentName}" not found`);
      }

      const { client } = agents[agentName];
      
      // Send message to A2A agent
      const sendResponse: SendMessageResponse = await client.sendMessage({
        message: {
          kind: "message",
          messageId: Date.now().toString(),
          role: "agent",
          parts: [{ text: task, kind: "text" }],
        },
      });

      if ("error" in sendResponse) {
        throw new Error(`Error sending message to agent "${agentName}": ${sendResponse.error.message}`);
      }

      const result = (sendResponse as SendMessageSuccessResponse).result;
      let responseContent = "";

      if (result.kind === "message" && result.parts.length > 0 && result.parts[0].kind === "text") {
        responseContent = result.parts[0].text;
      } else {
        responseContent = JSON.stringify(result);
      }

      // Emit the tool call result with the A2A response
      observer.next({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: toolCallResultEvent.toolCallId,
        messageId: randomUUID(),
        content: `The agent responded: ${responseContent}`,
      } as ToolCallResultEvent);

    } catch (error) {
      // Emit error result
      observer.next({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: toolCallResultEvent.toolCallId,
        messageId: randomUUID(),
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      } as ToolCallResultEvent);
    }
  }
}
