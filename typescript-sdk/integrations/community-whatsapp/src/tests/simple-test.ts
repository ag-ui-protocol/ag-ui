import { WhatsAppAgent } from "../agents/whatsapp-agent";

// Simple test to understand the WhatsApp agent
export async function simpleTest() {
  console.log("🤖 Creating WhatsApp Agent...");
  
  // Create a basic WhatsApp agent
  const agent = new WhatsAppAgent({
    phoneNumberId: "test-phone-id",
    accessToken: "test-access-token", 
    webhookSecret: "test-webhook-secret",
    threadId: "test-conversation",
  });

  console.log("✅ Agent created successfully!");
  console.log("📱 Phone Number ID:", agent.phoneNumberId);
  console.log("🧵 Thread ID:", agent.threadId);

  // Test webhook signature verification
  console.log("\n🔐 Testing webhook signature verification...");
  const testBody = '{"test": "data"}';
  const testSignature = "sha256=1234567890abcdef";
  
  const isValid = agent.verifyWebhookSignature(testBody, testSignature);
  console.log("✅ Signature verification test completed (result:", isValid, ")");

  // Test message conversion
  console.log("\n📝 Testing message conversion...");
  const whatsappMessage = {
    id: "test-message-id",
    from: "1234567890",
    timestamp: "1234567890",
    type: "text" as const,
    text: {
      body: "Hello from WhatsApp!"
    }
  };

  const aguiMessage = agent.convertWhatsAppMessageToAGUI(whatsappMessage);
  console.log("✅ WhatsApp message converted to AG-UI format:");
  console.log("   ID:", aguiMessage.id);
  console.log("   Role:", aguiMessage.role);
  console.log("   Content:", aguiMessage.content);

  // Test webhook processing
  console.log("\n📨 Testing webhook processing...");
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
          messages: [whatsappMessage]
        },
        field: "messages"
      }]
    }]
  };

  const messages = agent.processWebhook(testWebhook);
  console.log("✅ Webhook processed, found", messages.length, "message(s)");

  console.log("\n🎉 All tests completed successfully!");
  return agent;
}

// Run the test if this file is executed directly
if (require.main === module) {
  simpleTest().catch(console.error);
} 