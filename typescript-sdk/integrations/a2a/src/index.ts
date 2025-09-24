import {
  AbstractAgent,
  AgentConfig,
  BaseEvent,
  EventType,
  RunAgentInput,
  ToolCallResultEvent,
  Message,
  ToolCallStartEvent,
  transformChunks,
} from "@ag-ui/client";


import { A2AClient } from "@a2a-js/sdk/client";
import {AgentCard, SendMessageResponse, SendMessageSuccessResponse} from "@a2a-js/sdk";
import { Observable, Subscriber, tap } from "rxjs";
import {
  createSystemPrompt,
  getToolDefinition,
  makeNameMachineSafe,
} from "./utils";
import { randomUUID } from "crypto";



export interface A2AAgentConfig extends AgentConfig {
  agentUrls: string[];
  instructions?: string;
  orchestrationAgent: AbstractAgent;
}

export class A2AMiddlewareAgent extends AbstractAgent {
  agentClients: A2AClient[];
  agentCards: Promise<AgentCard[]>;
  instructions?: string;
  orchestrationAgent: AbstractAgent

  constructor(config: A2AAgentConfig) {
    super(config);
    this.instructions = config.instructions;
    this.agentClients = config.agentUrls.map((url) => new A2AClient(url));
    this.agentCards = Promise.all(
      this.agentClients.map((client) => client.getAgentCard()),
    );
    this.orchestrationAgent = config.orchestrationAgent;
  }


  wrapStream(stream: Observable<BaseEvent>, pendingA2ACalls: Set<string>, observer: Subscriber<{
    type: EventType;
    timestamp?: number | undefined;
    rawEvent?: any;
}>, input: RunAgentInput): any {
    return stream.pipe(
      transformChunks(this.debug),
    ).subscribe({
      next: (event: BaseEvent) => {
        // Handle tool call start events for send_message_to_a2a_agent
        if (event.type === EventType.TOOL_CALL_START &&
            'toolCallName' in event &&
            'toolCallId' in event &&
            (event as ToolCallStartEvent).toolCallName.startsWith('send_message_to_a2a_agent')) {
          // Track this as a pending A2A call
          pendingA2ACalls.add(event.toolCallId as string);
          // Proxy the start event normally
          observer.next(event);
          return;
        }

        // Handle tool call result events for send_message_to_a2a_agent
        if (event.type === EventType.TOOL_CALL_RESULT &&
            'toolCallId' in event &&
            pendingA2ACalls.has(event.toolCallId as string)) {
          // This is a result for our A2A tool call
          pendingA2ACalls.delete(event.toolCallId as string);
          observer.next(event);
          return;
        }

        // Handle run completion events
        if (event.type === EventType.RUN_FINISHED) {

          if (pendingA2ACalls.size > 0) {
            const callProms = [...pendingA2ACalls].map((toolCallId) => {
              const toolCallsFromMessages = input.messages.filter((message) => message.role == 'assistant')
                .map(messages => messages.toolCalls?.filter((toolCall) => toolCall.id === toolCallId) || [])
                .reduce((acc, curr) => acc.concat(curr), []);

              const toolName = toolCallsFromMessages[0]?.function.name;
              const toolArgs = toolCallsFromMessages
                .map((toolCall) => toolCall.function.arguments)
                .reduce((acc, curr) => acc > curr ? acc : curr, '');

                return this.sendMessageToA2AAgent(toolArgs, toolName).then((a2aResponse) => {
                  const newMessage = {
                    id: randomUUID(),
                    role: "tool",
                    toolCallId: toolCallId,
                    content: `A2A Agent Response: ${a2aResponse}`,
                    timestamp: Date.now(),
                    parts: [{ kind: "text", text: `A2A Agent Response: ${a2aResponse}` }]
                  } as Message;
                  input.messages.push(newMessage);


                  observer.next({
                    type: EventType.TOOL_CALL_RESULT,
                    toolCallId: toolCallId,
                    messageId: newMessage.id,
                    content: a2aResponse,
                  } as ToolCallResultEvent);

                  pendingA2ACalls.delete(toolCallId);
                }).finally(() => {
                  pendingA2ACalls.delete(toolCallId as string);
                })
            })

            Promise.all(callProms).then (() => {
              this.triggerNewRun(observer, input, pendingA2ACalls)
            })

          } else {
            observer.next(event);
            observer.complete();
            return;
          }
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
        if (pendingA2ACalls.size === 0) {
          observer.complete();
        }
      }
    });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((observer) => {
      const run = async () => {
      let pendingA2ACalls = new Set<string>();


      const agentCards = await this.agentCards;

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

      input.tools = [
        ...(input.tools || []),
        ...agentCards.map((card) => getToolDefinition(card))
      ]

      // Start the orchestration agent run
      const orchestrationStream = this.orchestrationAgent.run(input);

      const subscription = this.wrapStream(orchestrationStream, pendingA2ACalls, observer, input);

    }
    run()
    });
  }

  private async sendMessageToA2AAgent(
    args: string,
    toolName: string): Promise<string> {

    const agentCards = await this.agentCards;

    const agents = agentCards.map((card, index) => {
        return { client: this.agentClients[index], card }});

    const agent = agents.find((agent) =>  toolName === `send_message_to_a2a_agent_${makeNameMachineSafe(agent.card.name)}`);

    if (!agent) {
      throw new Error(`Agent for "${toolName}" not found`);
    }

    const { client } = agent;

    const sendResponse: SendMessageResponse = await client.sendMessage({
      message: {
        kind: "message",
        messageId: Date.now().toString(),
        role: "agent",
        parts: [{ text: args, kind: "text" }],
      },
    });

    if ("error" in sendResponse) {
      throw new Error(`Error sending message to agent "${toolName}": ${sendResponse.error.message}`);
    }

    const result = (sendResponse as SendMessageSuccessResponse).result;
    let responseContent = "";

    if (result.kind === "message" && result.parts.length > 0 && result.parts[0].kind === "text") {
      responseContent = result.parts[0].text;
    } else {
      responseContent = JSON.stringify(result);
    }

    return responseContent;
  }

  private triggerNewRun(
    observer: any,
    input: RunAgentInput,
    pendingA2ACalls: Set<string>,
  ): void {
    const newRunStream = this.orchestrationAgent.run(input);
    this.wrapStream(newRunStream, pendingA2ACalls, observer, input);
  }
}
