import { createHmac } from "crypto";
import { WhatsAppWebhookEntry, WhatsAppMessage } from "../types";

/**
 * Verify webhook signature from WhatsApp
 */
export function verifyWebhookSignature(body: string, signature: string, webhookSecret: string): boolean {
  const expectedSignature = createHmac("sha256", webhookSecret)
    .update(body)
    .digest("hex");
  
  return signature === `sha256=${expectedSignature}`;
}

/**
 * Process incoming webhook from WhatsApp
 */
export function processWebhook(body: WhatsAppWebhookEntry): WhatsAppMessage[] {
  const messages: WhatsAppMessage[] = [];
  
  for (const entry of body.entry) {
    for (const change of entry.changes) {
      if (change.value.messages) {
        messages.push(...change.value.messages);
      }
    }
  }
  
  return messages;
} 