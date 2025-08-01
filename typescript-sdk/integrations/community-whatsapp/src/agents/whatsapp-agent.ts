import { AbstractAgent, BaseEvent, EventType, Message, RunAgentInput, TextMessageChunkEvent, RunStartedEvent, RunFinishedEvent } from "@ag-ui/client";
import { Observable } from "rxjs";
import { WhatsAppAgentConfig, WhatsAppMessage, WhatsAppSendMessageRequest, WhatsAppSendMessageResponse, WhatsAppWebhookEntry } from "../types";
import { verifyWebhookSignature, processWebhook, convertWhatsAppMessageToAGUI, convertAGUIMessageToWhatsApp } from "../utils";

export class WhatsAppAgent extends AbstractAgent {
  public phoneNumberId: string;
  private accessToken: string;
  private webhookSecret: string;
  private apiVersion: string;
  private baseUrl: string;

  constructor(config: WhatsAppAgentConfig) {
    super(config);
    this.phoneNumberId = config.phoneNumberId;
    this.accessToken = config.accessToken;
    this.webhookSecret = config.webhookSecret;
    this.apiVersion = config.apiVersion || "v18.0";
    this.baseUrl = config.baseUrl || `https://graph.facebook.com/${this.apiVersion}`;
  }

  /**
   * Verify webhook signature from WhatsApp
   */
  verifyWebhookSignature(body: string, signature: string): boolean {
    return verifyWebhookSignature(body, signature, this.webhookSecret);
  }

  /**
   * Process incoming webhook from WhatsApp
   */
  processWebhook(body: WhatsAppWebhookEntry): WhatsAppMessage[] {
    return processWebhook(body);
  }

  /**
   * Send a message to WhatsApp
   */
  async sendMessage(to: string, message: WhatsAppSendMessageRequest): Promise<WhatsAppSendMessageResponse> {
    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
    
    const requestBody = {
      ...message,
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
    };

    console.log("=== WHATSAPP API REQUEST DEBUG ===");
    console.log("URL:", url);
    console.log("Method: POST");
    console.log("Headers:", {
      "Authorization": `Bearer ${this.accessToken.substring(0, 20)}...`,
      "Content-Type": "application/json",
    });
    console.log("Body:", JSON.stringify(requestBody, null, 2));
    console.log("==================================");
    
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.json();
      console.log("=== WHATSAPP API ERROR DEBUG ===");
      console.log("Status:", response.status);
      console.log("Status Text:", response.statusText);
      console.log("Error Response:", JSON.stringify(error, null, 2));
      console.log("==================================");
      throw new Error(`WhatsApp API error: ${error.error?.message || response.statusText}`);
    }

    return response.json();
  }

  /**
   * Send a text message
   */
  async sendTextMessage(to: string, text: string): Promise<WhatsAppSendMessageResponse> {
    return this.sendMessage(to, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: {
        body: text,
      },
    });
  }

  /**
   * Convert WhatsApp message to AG-UI message format
   */
  public convertWhatsAppMessageToAGUI(whatsappMessage: WhatsAppMessage): Message {
    return convertWhatsAppMessageToAGUI(whatsappMessage);
  }

  /**
   * Convert AG-UI message to WhatsApp message format
   */
  private convertAGUIMessageToWhatsApp(message: Message): WhatsAppSendMessageRequest {
    return convertAGUIMessageToWhatsApp(message);
  }

  /**
   * Main run method that processes messages and generates responses
   */
  protected run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const run = async () => {
        try {
          // Emit run started event
          const runStartedEvent: RunStartedEvent = {
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          };
          subscriber.next(runStartedEvent);

          // Process incoming messages
          for (const message of input.messages) {
            if (message.role === "user") {
              // For now, we'll simulate a response
              // In a real implementation, you would integrate with an AI service
              const responseText = `Received: ${message.content}`;
              
              // Emit text chunks
              const textChunkEvent: TextMessageChunkEvent = {
                type: EventType.TEXT_MESSAGE_CHUNK,
                role: "assistant",
                messageId: message.id,
                delta: responseText,
              };
              subscriber.next(textChunkEvent);
            }
          }

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
      };

      run();
    });
  }

  /**
   * Handle incoming webhook and process messages
   */
  async handleWebhook(body: string, signature: string): Promise<void> {
    // Verify webhook signature
    if (!this.verifyWebhookSignature(body, signature)) {
      throw new Error("Invalid webhook signature");
    }

    const webhookData: WhatsAppWebhookEntry = JSON.parse(body);
    const messages = this.processWebhook(webhookData);

    // Process each message
    for (const whatsappMessage of messages) {
      const aguiMessage = this.convertWhatsAppMessageToAGUI(whatsappMessage);
      this.addMessage(aguiMessage);

      // Run the agent to generate a response
      const result = await this.runAgent();
      
      // Send the response back to WhatsApp
      if (result.newMessages.length > 0) {
        const responseMessage = result.newMessages[0];
        await this.sendTextMessage(whatsappMessage.from, responseMessage.content || "");
      }
    }
  }

  /**
   * Send a message to a specific WhatsApp number
   */
  async sendMessageToNumber(phoneNumber: string, content: string): Promise<WhatsAppSendMessageResponse> {
    return this.sendTextMessage(phoneNumber, content);
  }
} 