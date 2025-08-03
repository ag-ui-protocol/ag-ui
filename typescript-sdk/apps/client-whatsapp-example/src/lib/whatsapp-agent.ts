import crypto from 'crypto';

export interface WhatsAppAgentConfig {
  phoneNumberId: string;
  accessToken: string;
  webhookSecret: string;
  apiVersion?: string;
  baseUrl?: string;
}

export interface WhatsAppSendMessageResponse {
  messaging_product: string;
  contacts: Array<{
    input: string;
    wa_id: string;
  }>;
  messages: Array<{
    id: string;
  }>;
}

export class WhatsAppAgent {
  public phoneNumberId: string;
  private accessToken: string;
  private webhookSecret: string;
  private apiVersion: string;
  private baseUrl: string;

  constructor(config: WhatsAppAgentConfig) {
    this.phoneNumberId = config.phoneNumberId;
    this.accessToken = config.accessToken;
    this.webhookSecret = config.webhookSecret;
    this.apiVersion = config.apiVersion || "v23.0";
    this.baseUrl = config.baseUrl || `https://graph.facebook.com/${this.apiVersion}`;
  }

  /**
   * Verify webhook signature from WhatsApp
   */
  verifyWebhookSignature(body: string, signature: string): boolean {
    const expectedSignature = `sha256=${crypto
      .createHmac('sha256', this.webhookSecret)
      .update(body)
      .digest('hex')}`;
    
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }

  /**
   * Process incoming webhook from WhatsApp
   */
  processWebhook(body: any): any[] {
    const messages: any[] = [];
    
    if (body.entry && body.entry.length > 0) {
      for (const entry of body.entry) {
        if (entry.changes && entry.changes.length > 0) {
          for (const change of entry.changes) {
            if (change.value && change.value.messages) {
              messages.push(...change.value.messages);
            }
          }
        }
      }
    }
    
    return messages;
  }

  /**
   * Send a text message to a phone number
   */
  async sendMessageToNumber(phoneNumber: string, content: string): Promise<WhatsAppSendMessageResponse> {
    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
    
    const requestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phoneNumber,
      type: "text",
      text: {
        body: content,
      },
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
} 