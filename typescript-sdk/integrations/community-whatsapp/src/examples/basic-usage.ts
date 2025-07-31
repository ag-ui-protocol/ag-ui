import { WhatsAppAgent } from "../agents/whatsapp-agent";

// Example usage of the WhatsApp agent
export async function exampleUsage() {
  // Create a WhatsApp agent instance
  const agent = new WhatsAppAgent({
    phoneNumberId: "your-phone-number-id",
    accessToken: "your-access-token",
    webhookSecret: "your-webhook-secret",
    threadId: "whatsapp-conversation-1",
  });

  // Example: Handle incoming webhook
  const webhookBody = `{
    "object": "whatsapp_business_account",
    "entry": [
      {
        "id": "123456789",
        "changes": [
          {
            "value": {
              "messaging_product": "whatsapp",
              "metadata": {
                "display_phone_number": "+1234567890",
                "phone_number_id": "your-phone-number-id"
              },
              "contacts": [
                {
                  "profile": {
                    "name": "John Doe"
                  },
                  "wa_id": "1234567890"
                }
              ],
              "messages": [
                {
                  "from": "1234567890",
                  "id": "wamid.123456789",
                  "timestamp": "1234567890",
                  "type": "text",
                  "text": {
                    "body": "Hello, how are you?"
                  }
                }
              ]
            },
            "field": "messages"
          }
        ]
      }
    ]
  }`;

  const signature = "sha256=your-signature-here";

  try {
    // Handle the webhook
    await agent.handleWebhook(webhookBody, signature);
    console.log("Webhook processed successfully");
  } catch (error) {
    console.error("Error processing webhook:", error);
  }

  // Example: Send a message directly
  try {
    const response = await agent.sendMessageToNumber("1234567890", "Hello from AG-UI!");
    console.log("Message sent:", response);
  } catch (error) {
    console.error("Error sending message:", error);
  }
}

// Example Express.js webhook handler
export function createWebhookHandler(agent: WhatsAppAgent) {
  return async (req: any, res: any) => {
    try {
      const signature = req.headers["x-hub-signature-256"];
      const body = JSON.stringify(req.body);

      await agent.handleWebhook(body, signature);
      
      res.status(200).json({ status: "ok" });
    } catch (error) {
      console.error("Webhook error:", error);
      res.status(400).json({ error: "Invalid webhook" });
    }
  };
} 