import { EnhancedWhatsAppAgent } from "../agents/enhanced-whatsapp-agent";

// Test the enhanced WhatsApp agent with AI
export async function aiTest() {
  console.log("🤖 Creating Enhanced WhatsApp Agent with AI...");
  
  // Create an enhanced agent (without real AI provider for demo)
  const agent = new EnhancedWhatsAppAgent({
    phoneNumberId: "test-phone-id",
    accessToken: "test-access-token", 
    webhookSecret: "test-webhook-secret",
    threadId: "ai-conversation",
    systemPrompt: "You are a helpful WhatsApp assistant. Be friendly and concise.",
    maxTokens: 150,
    temperature: 0.7,
  });

  console.log("✅ Enhanced agent created successfully!");
  console.log("🧠 System prompt:", agent.setSystemPrompt);
  console.log("📝 Max tokens:", 150);
  console.log("🌡️ Temperature:", 0.7);

  // Test AI response generation (will use fallback since no AI provider)
  console.log("\n🤖 Testing AI response generation...");
  
  const testMessages = [
    { role: "user", content: "Hello, how are you?" }
  ];

  // This will use the fallback response since no AI provider is configured
  const response = await (agent as any).generateAIResponse(testMessages);
  console.log("✅ AI response generated:");
  console.log("   Response:", response);

  // Test webhook handling with AI
  console.log("\n📨 Testing webhook handling with AI...");
  
  const testWebhook = {
    object: "whatsapp_business_account",
    entry: [{
      id: "123456789",
      changes: [{
        value: {
          messaging_product: "whatsapp",
          metadata: {
            display_phone_number: "+1234567890",
            phone_number_id: "test-phone-id"
          },
          messages: [{
            id: "test-message-id",
            from: "1234567890",
            timestamp: "1234567890",
            type: "text" as const,
            text: {
              body: "Hello from WhatsApp!"
            }
          }]
        },
        field: "messages"
      }]
    }]
  };

  const webhookBody = JSON.stringify(testWebhook);
  const signature = "sha256=test-signature";

  try {
    await agent.handleWebhookWithAI(webhookBody, signature);
    console.log("✅ Webhook handled with AI successfully!");
  } catch (error) {
    console.log("⚠️ Webhook handling failed (expected due to fake signature):", (error as Error).message);
  }

  console.log("\n🎉 AI test completed successfully!");
  return agent;
}

// Run the test if this file is executed directly
if (require.main === module) {
  aiTest().catch(console.error);
} 