import { Observable, Subscriber } from "rxjs";
import { 
  AbstractAgent, 
  AgentConfig, 
  BaseEvent, 
  EventType, 
  MessagesSnapshotEvent, 
  RunAgentInput, 
  RunFinishedEvent, 
  RunStartedEvent, 
  TextMessageContentEvent, 
  TextMessageEndEvent, 
  TextMessageStartEvent,
  Message as AGUIMessage
} from "@ag-ui/client";

export interface FlowiseAgentConfig extends AgentConfig {
  /**
   * The Flowise API endpoint URL
   * Example: "http://localhost:3000/api/v1/prediction/{flowId}"
   */
  apiUrl: string;
  
  /**
   * The Flowise flow ID
   */
  flowId: string;
  
  /**
   * API key for authentication (if required)
   */
  apiKey?: string;
  
  /**
   * Additional headers to send with requests
   */
  headers?: Record<string, string>;
}

export interface FlowiseResponse {
  text: string;
  question: string;
  chatId?: string;
  sessionId?: string;
  sourceDocuments?: Array<{
    pageContent: string;
    metadata: Record<string, any>;
  }>;
  usedTools?: Array<{
    tool: string;
    toolInput: Record<string, any>;
    toolOutput: string;
  }>;
}

export class FlowiseAgent extends AbstractAgent {
  private config: FlowiseAgentConfig;
  private apiUrl: string;

  constructor(config: FlowiseAgentConfig) {
    super(config);
    this.config = config;
    this.apiUrl = config.apiUrl.replace('{flowId}', config.flowId);
  }

  public clone() {
    return new FlowiseAgent(this.config);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.runFlowise(input, subscriber);
      return () => {};
    });
  }

  private async runFlowise(input: RunAgentInput, subscriber: Subscriber<BaseEvent>) {
    try {
      // Emit run started event
      const runStartedEvent: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      };
      subscriber.next(runStartedEvent);

      // Get the last user message
      const lastUserMessage = this.getLastUserMessage(input.messages);
      if (!lastUserMessage) {
        throw new Error("No user message found");
      }

      // Prepare the request to Flowise
      const requestBody = {
        question: lastUserMessage.content,
        history: this.formatHistory(input.messages),
        overrideConfig: {
          sessionId: input.threadId,
        }
      };

      // Set up headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...this.config.headers
      };
      
      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }

      // Make the API call to Flowise
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        throw new Error(`Flowise API error: ${response.status} ${response.statusText}`);
      }

      const flowiseResponse: FlowiseResponse = await response.json();

      // Emit text message events
      const messageId = Date.now().toString();
      
      const textMessageStartEvent: TextMessageStartEvent = {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant"
      };
      subscriber.next(textMessageStartEvent);

      const textMessageContentEvent: TextMessageContentEvent = {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: flowiseResponse.text
      };
      subscriber.next(textMessageContentEvent);

      const textMessageEndEvent: TextMessageEndEvent = {
        type: EventType.TEXT_MESSAGE_END,
        messageId
      };
      subscriber.next(textMessageEndEvent);

      // Emit messages snapshot
      const messagesSnapshotEvent: MessagesSnapshotEvent = {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          ...input.messages,
          {
            id: messageId,
            role: "assistant",
            content: flowiseResponse.text,
            timestamp: new Date().toISOString()
          }
        ]
      };
      subscriber.next(messagesSnapshotEvent);

      // Emit run finished event
      const runFinishedEvent: RunFinishedEvent = {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      };
      subscriber.next(runFinishedEvent);
      
      subscriber.complete();
    } catch (error) {
      subscriber.error(error);
    }
  }

  private getLastUserMessage(messages: AGUIMessage[]): AGUIMessage | null {
    // Find the last user message by working backwards from the last message
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        return messages[i];
      }
    }
    return null;
  }

  private formatHistory(messages: AGUIMessage[]): Array<{role: string, content: string}> {
    return messages
      .filter(msg => msg.role === "user" || msg.role === "assistant")
      .map(msg => ({
        role: msg.role === "user" ? "userMessage" : "apiMessage",
        content: msg.content
      }));
  }
}