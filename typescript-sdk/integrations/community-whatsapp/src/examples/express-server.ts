import { EnhancedWhatsAppAgent } from "../agents/enhanced-whatsapp-agent";
import { OpenAIProvider } from "../providers";

/**
 * Example Express.js server with WhatsApp integration
 */
export function createExpressServer() {
  const express = require("express");
  const app = express();

  // Create agent
  const openAIProvider = new OpenAIProvider("your-openai-api-key");
  const agent = new EnhancedWhatsAppAgent({
    phoneNumberId: "your-phone-number-id",
    accessToken: "your-access-token",
    webhookSecret: "your-webhook-secret",
    threadId: "whatsapp-express-conversation",
    aiProvider: openAIProvider,
  });

  // Middleware
  app.use(express.json());

  // Webhook endpoint
  app.post("/webhook", async (req: any, res: any) => {
    try {
      const signature = req.headers["x-hub-signature-256"];
      const body = JSON.stringify(req.body);

      await agent.handleWebhookWithAI(body, signature);
      
      res.status(200).json({ status: "ok" });
    } catch (error) {
      console.error("Webhook error:", error);
      res.status(400).json({ error: "Invalid webhook" });
    }
  });

  // Health check endpoint
  app.get("/health", (req: any, res: any) => {
    res.json({ status: "healthy", agent: "Express WhatsApp Assistant" });
  });

  // Send message endpoint
  app.post("/send", async (req: any, res: any) => {
    try {
      const { phoneNumber, message } = req.body;
      
      if (!phoneNumber || !message) {
        return res.status(400).json({ error: "phoneNumber and message are required" });
      }

      const response = await agent.sendMessageToNumber(phoneNumber, message);
      res.json(response);
    } catch (error) {
      console.error("Send message error:", error);
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  // Update AI settings endpoint
  app.post("/ai-settings", (req: any, res: any) => {
    try {
      const { systemPrompt, maxTokens, temperature } = req.body;
      
      if (systemPrompt) {
        agent.setSystemPrompt(systemPrompt);
      }
      
      if (maxTokens && temperature) {
        agent.setAIParameters(maxTokens, temperature);
      }

      res.json({ status: "settings updated" });
    } catch (error) {
      console.error("Settings update error:", error);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  return app;
} 