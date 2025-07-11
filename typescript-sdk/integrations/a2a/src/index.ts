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
import { A2AClient, SendMessageResponse, SendMessageSuccessResponse } from "@a2a-js/sdk";
import { Observable } from "rxjs";
import { LanguageModel, processDataStream, streamText, tool } from "ai";
import {
  convertMessagesToVercelAISDKMessages,
  convertToolToVercelAISDKTools,
  createSystemPrompt,
} from "./utils";
import { z } from "zod";
import { randomUUID } from "crypto";

export interface A2AAgentConfig extends AgentConfig {
  agentUrls: string[];
  instructions?: string;
  model: LanguageModel;
}

export class A2AClientAgent extends AbstractAgent {
  agentClients: A2AClient[];
  instructions?: string;
  model: LanguageModel;

  constructor(config: A2AAgentConfig) {
    super(config);
    this.instructions = config.instructions;
    this.agentClients = config.agentUrls.map((url) => new A2AClient(url));
    this.model = config.model;
  }

  protected run(input: RunAgentInput): Observable<BaseEvent> {
    const state: any = { a2aMessages: [] };

    return new Observable<BaseEvent>((observer) => {
      const run = async () => {
        try {
          observer.next({
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          } as any);

          observer.next({
            type: EventType.STATE_SNAPSHOT,
            snapshot: state,
          } as StateSnapshotEvent);

          const agentCards = await Promise.all(
            this.agentClients.map((client) => client.getAgentCard()),
          );

          const agents = Object.fromEntries(
            agentCards.map((card, index) => [
              card.name,
              { client: this.agentClients[index], card },
            ]),
          );

          const systemPrompt = createSystemPrompt(agentCards, this.instructions);

          const messages = convertMessagesToVercelAISDKMessages(input.messages);
          if (messages.length && messages[0].role === "system") {
            // remove the first message if it is a system message
            messages.shift();
          }

          messages.unshift({
            role: "system",
            content: systemPrompt,
          });

          const sendMessageTool = tool({
            description:
              "Sends a task to the agent named `agentName`, including the full conversation context and goal.",
            parameters: z.object({
              agentName: z.string().describe("The name of the agent to send the task to."),
              task: z
                .string()
                .describe(
                  "The comprehensive conversation-context summary and goal " +
                    "to be achieved regarding the user inquiry.",
                ),
            }),
            async execute({ agentName, task }) {
              state.a2aMessages.push({ name: "Agent", to: agentName, message: task });
              observer.next({
                type: EventType.STATE_SNAPSHOT,
                snapshot: state,
              } as StateSnapshotEvent);

              if (!Object.keys(agents).includes(agentName)) {
                return `Agent "${agentName}" not found.`;
              }
              const { client } = agents[agentName];
              const sendResponse: SendMessageResponse = await client.sendMessage({
                message: {
                  kind: "message",
                  messageId: Date.now().toString(),
                  role: "agent",
                  parts: [{ text: task, kind: "text" }],
                },
              });

              if ("error" in sendResponse) {
                console.error(sendResponse.error);
                return `Error sending message to agent "${agentName}": ${sendResponse.error.message}`;
              }
              const result = (sendResponse as SendMessageSuccessResponse).result;

              if (
                result.kind === "message" &&
                result.parts.length > 0 &&
                result.parts[0].kind === "text"
              ) {
                state.a2aMessages.push({
                  name: agentName,
                  to: "Agent",
                  message: result.parts[0].text,
                });
                observer.next({
                  type: EventType.STATE_SNAPSHOT,
                  snapshot: state,
                } as StateSnapshotEvent);
              }

              return "The agent responded: " + JSON.stringify(result);
            },
          });

          const response = streamText({
            model: this.model,
            messages,
            tools: {
              ...convertToolToVercelAISDKTools(input.tools),
              sendMessage: sendMessageTool,
            },
            maxSteps: 10,
            toolCallStreaming: true,
          });

          let messageId = randomUUID();

          await processDataStream({
            stream: response.toDataStreamResponse().body!,
            onTextPart: (text) => {
              const event: TextMessageChunkEvent = {
                type: EventType.TEXT_MESSAGE_CHUNK,
                role: "assistant",
                messageId,
                delta: text,
              };
              observer.next(event);
            },
            onFinishMessagePart(streamPart) {
              // reset the messageId
              messageId = randomUUID();
            },
            onToolCallStreamingStartPart(streamPart) {
              const event: ToolCallChunkEvent = {
                type: EventType.TOOL_CALL_CHUNK,
                toolCallId: streamPart.toolCallId,
                parentMessageId: messageId,
                toolCallName: streamPart.toolName,
              };
              observer.next(event);
            },
            onToolCallDeltaPart(streamPart) {
              const event: ToolCallChunkEvent = {
                type: EventType.TOOL_CALL_CHUNK,
                toolCallId: streamPart.toolCallId,
                delta: streamPart.argsTextDelta,
                parentMessageId: messageId,
              };
              observer.next(event);
            },

            // onToolCallPart(streamPart) {
            //   const event: ToolCallChunkEvent = {
            //     type: EventType.TOOL_CALL_CHUNK,
            //     toolCallId: streamPart.toolCallId,
            //     delta: JSON.stringify(streamPart.args),
            //     toolCallName: streamPart.toolName,
            //     parentMessageId: messageId,
            //   };
            //   console.log("[EVENT]", event);
            //   observer.next(event);
            // },
            onToolResultPart(streamPart) {
              const event: ToolCallResultEvent = {
                messageId: randomUUID(),
                type: EventType.TOOL_CALL_RESULT,
                toolCallId: streamPart.toolCallId,
                content:
                  typeof streamPart.result === "string"
                    ? streamPart.result
                    : JSON.stringify(streamPart.result),
              };
              observer.next(event);
            },
          });

          observer.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          } as any);

          observer.complete();
        } catch (error) {
          observer.next({
            type: EventType.RUN_ERROR,
            threadId: input.threadId,
            runId: input.runId,
            message: error instanceof Error ? error.message : "Unknown error",
          } as RunErrorEvent);
          observer.error(error);
        }
      };

      run();
    });
  }
}
