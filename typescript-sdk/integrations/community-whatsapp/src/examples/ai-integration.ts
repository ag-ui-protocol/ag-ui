import { EnhancedWhatsAppAgent } from "../agents/enhanced-whatsapp-agent";
import { OpenAIProvider, AnthropicProvider } from "../providers";

// Example: Using WhatsApp agent with OpenAI
export async function openAIExample() {
  // Create OpenAI provider
  const openAIProvider = new OpenAIProvider("your-openai-api-key", "gpt-4");

  // Create enhanced WhatsApp agent
  const agent = new EnhancedWhatsAppAgent({
    phoneNumberId: "your-phone-number-id",
    accessToken: "your-access-token",
    webhookSecret: "your-webhook-secret",
    threadId: "whatsapp-ai-conversation",
    aiProvider: openAIProvider,
    systemPrompt: "You are a helpful customer service assistant for a tech company. Be friendly, professional, and concise.",
    maxTokens: 200,
    temperature: 0.7,
  });

  // Example webhook handler
  const webhookHandler = async (req: any, res: any) => {
    try {
      const signature = req.headers["x-hub-signature-256"];
      const body = JSON.stringify(req.body);

      await agent.handleWebhookWithAI(body, signature);
      
      res.status(200).json({ status: "ok" });
    } catch (error) {
      console.error("Webhook error:", error);
      res.status(400).json({ error: "Invalid webhook" });
    }
  };

  return { agent, webhookHandler };
}

// Example: Using WhatsApp agent with Anthropic Claude
export async function anthropicExample() {
  // Create Anthropic provider
  const anthropicProvider = new AnthropicProvider("your-anthropic-api-key", "claude-3-sonnet-20240229");

  // Create enhanced WhatsApp agent
  const agent = new EnhancedWhatsAppAgent({
    phoneNumberId: "your-phone-number-id",
    accessToken: "your-access-token",
    webhookSecret: "your-webhook-secret",
    threadId: "whatsapp-claude-conversation",
    aiProvider: anthropicProvider,
    systemPrompt: "You are Claude, an AI assistant helping users via WhatsApp. Be helpful, accurate, and conversational.",
    maxTokens: 300,
    temperature: 0.8,
  });

  return agent;
}

// Example: Dynamic AI provider switching
export async function dynamicAIExample() {
  const agent = new EnhancedWhatsAppAgent({
    phoneNumberId: "your-phone-number-id",
    accessToken: "your-access-token",
    webhookSecret: "your-webhook-secret",
    threadId: "whatsapp-dynamic-conversation",
  });

  // Switch between AI providers based on user preference or availability
  const switchToOpenAI = () => {
    const openAIProvider = new OpenAIProvider("your-openai-api-key");
    agent.setAIProvider(openAIProvider);
    agent.setSystemPrompt("You are an OpenAI-powered assistant.");
  };

  const switchToClaude = () => {
    const anthropicProvider = new AnthropicProvider("your-anthropic-api-key");
    agent.setAIProvider(anthropicProvider);
    agent.setSystemPrompt("You are Claude, an AI assistant.");
  };

  const disableAI = () => {
    agent.setAIProvider(undefined);
  };

  return { agent, switchToOpenAI, switchToClaude, disableAI };
}

// Example: Express.js server with WhatsApp integration
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

// Example: Environment-based configuration
export function createAgentFromEnv() {
  const config = {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
    webhookSecret: process.env.WHATSAPP_WEBHOOK_SECRET!,
    threadId: process.env.THREAD_ID || "whatsapp-env-conversation",
  };

  // Add AI provider based on environment
  if (process.env.OPENAI_API_KEY) {
    const openAIProvider = new OpenAIProvider(process.env.OPENAI_API_KEY);
    return new EnhancedWhatsAppAgent({
      ...config,
      aiProvider: openAIProvider,
      systemPrompt: process.env.SYSTEM_PROMPT || "You are a helpful assistant.",
    });
  } else if (process.env.ANTHROPIC_API_KEY) {
    const anthropicProvider = new AnthropicProvider(process.env.ANTHROPIC_API_KEY);
    return new EnhancedWhatsAppAgent({
      ...config,
      aiProvider: anthropicProvider,
      systemPrompt: process.env.SYSTEM_PROMPT || "You are Claude, an AI assistant.",
    });
  } else {
    // No AI provider configured
    return new EnhancedWhatsAppAgent(config);
  }
} 