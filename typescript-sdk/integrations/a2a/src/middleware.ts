import {
  AbstractAgent,
  AgentConfig,
  BaseEvent,
  EventType,
  RunAgentInput,
  ToolCallResultEvent,
  Message,
} from "@ag-ui/client";


import { A2AClient } from "@a2a-js/sdk/client";
import {SendMessageResponse, SendMessageSuccessResponse} from "@a2a-js/sdk";
import { Observable } from "rxjs";
import {
  createSystemPrompt,
  toolDefinition,
} from "./utils";
import { randomUUID } from "crypto";



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
      const run = async () => {
      let pendingA2ACalls = new Set<string>();
      let toolCallArguments = new Map<string, any>();
      let isRunComplete = false;

      const agentCards = await Promise.all(
        this.agentClients.map((client) => client.getAgentCard()),
      );

      const newSystemPrompt = createSystemPrompt(agentCards, this.instructions);

      const messages = input.messages;
      if (messages.length && messages[0].role === "system") {
        // remove the first message if it is a system message
        messages.shift();
      }

      messages.unshift({
        role: "system",
        content: newSystemPrompt,
        id: randomUUID(),
      });

      // Add the send_message_to_a2a_agent tool to the input
      const updatedInput = {
        ...input,
        messages: messages,
        tools: [
          ...(input.tools || []),
          toolDefinition
        ]
      };

      // Start the orchestration agent run
      const orchestrationStream = this.orchestrationAgent.run(updatedInput);

      const subscription = orchestrationStream.subscribe({
        next: (event: BaseEvent) => {
          // Handle tool call start events for send_message_to_a2a_agent
          if (event.type === EventType.TOOL_CALL_START &&
              'toolCallName' in event &&
              'toolCallId' in event &&
              event.toolCallName === 'send_message_to_a2a_agent') {
            // Track this as a pending A2A call
            pendingA2ACalls.add(event.toolCallId as string);
            // Proxy the start event normally
            observer.next(event);
            return;
          }

          // Handle tool call chunk events for send_message_to_a2a_agent
          if (event.type === EventType.TOOL_CALL_CHUNK &&
              'toolCallId' in event &&
              pendingA2ACalls.has(event.toolCallId as string)) {
            // Accumulate the arguments as they come in
            if ('delta' in event && event.delta) {
              const currentArgs = toolCallArguments.get(event.toolCallId as string) || '';
              toolCallArguments.set(event.toolCallId as string, currentArgs + event.delta);
            }
            // Proxy chunk events normally
            observer.next(event);
            return;
          }

          // Handle tool call result events for send_message_to_a2a_agent
          if (event.type === EventType.TOOL_CALL_RESULT &&
              'toolCallId' in event &&
              pendingA2ACalls.has(event.toolCallId as string)) {
            // This is a result for our A2A tool call
            pendingA2ACalls.delete(event.toolCallId as string);

            // Execute the A2A message sending function
            this.executeA2AMessage(event as ToolCallResultEvent, observer, input, toolCallArguments.get(event.toolCallId as string) || '{}').then((a2aResponse) => {
              // After A2A message is sent, if the run has finished, trigger a new run
              if (isRunComplete) {
                this.triggerNewRunWithA2AResponse(observer, input, a2aResponse, event.toolCallId as string);
              }
            }).catch((error) => {
              // Handle A2A error
              observer.next({
                type: EventType.TOOL_CALL_RESULT,
                toolCallId: event.toolCallId as string,
                messageId: randomUUID(),
                content: `Error sending A2A message: ${error.message}`,
              } as ToolCallResultEvent);

              // If run has finished and we got an error, still trigger a new run with the error
              if (isRunComplete) {
                this.triggerNewRunWithA2AResponse(observer, input, `Error: ${error.message}`, event.toolCallId as string);
              }
            });

            // Don't proxy the original result event
            return;
          }

          // Handle run completion events
          if (event.type === EventType.RUN_FINISHED) {
            isRunComplete = true;

            // Only pass completion events if no pending A2A calls
            if (pendingA2ACalls.size === 0) {
              observer.next(event);
              observer.complete();
            }
            // If there are pending calls, don't emit completion events yet
            return;
          }

          // Handle run error events - emit immediately and exit
          if (event.type === EventType.RUN_ERROR) {
            observer.next(event);
            observer.error(event);
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
    }
    run()
    });
  }

  private async executeA2AMessage(
    toolCallResultEvent: ToolCallResultEvent,
    observer: any,
    input: RunAgentInput,
    toolCallArgs: string
  ): Promise<string> {
    try {
      // Parse the accumulated tool call arguments
      const args = JSON.parse(toolCallArgs);
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

      return responseContent;

    } catch (error) {
      // Emit error result
      const errorMessage = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
      observer.next({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: toolCallResultEvent.toolCallId,
        messageId: randomUUID(),
        content: errorMessage,
      } as ToolCallResultEvent);

      throw error; // Re-throw to be caught by the caller
    }
  }

  private triggerNewRunWithA2AResponse(
    observer: any,
    originalInput: RunAgentInput,
    a2aResponse: string,
    toolCallId: string
  ): void {
    // Create a new input with the A2A response added as a message
    const newInput: RunAgentInput = {
      ...originalInput,
      messages: [
        ...originalInput.messages,
        {
          id: randomUUID(),
          role: "assistant",
          content: `A2A Agent Response: ${a2aResponse}`,
          timestamp: Date.now(),
          parts: [{ kind: "text", text: `A2A Agent Response: ${a2aResponse}` }]
        } as Message
      ]
    };

    // Start a new run with the updated input
    const newRunStream = this.orchestrationAgent.run(newInput);

    // Subscribe to the new run and proxy all events
    const newSubscription = newRunStream.subscribe({
      next: (event: BaseEvent) => {
        observer.next(event);
      },
      error: (error) => {
        observer.error(error);
      },
      complete: () => {
        observer.complete();
      }
    });
  }
}
