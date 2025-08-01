import { WhatsAppAgent } from "../agents/whatsapp-agent";
import { WhatsAppMessage } from "../types";

describe("WhatsAppAgent", () => {
  let agent: WhatsAppAgent;

  beforeEach(() => {
    agent = new WhatsAppAgent({
      phoneNumberId: "test-phone-number-id",
      accessToken: "test-access-token",
      webhookSecret: "test-webhook-secret",
      description: "Test WhatsApp Agent",
      threadId: "test-thread-id",
    });
  });

  describe("constructor", () => {
    it("should create a WhatsApp agent with correct configuration", () => {
      expect(agent).toBeInstanceOf(WhatsAppAgent);
      expect(agent.description).toBe("Test WhatsApp Agent");
      expect(agent.threadId).toBe("test-thread-id");
    });

    it("should use default API version when not provided", () => {
      const agentWithDefaults = new WhatsAppAgent({
        phoneNumberId: "test-phone-number-id",
        accessToken: "test-access-token",
        webhookSecret: "test-webhook-secret",
      });
      
      expect(agentWithDefaults).toBeInstanceOf(WhatsAppAgent);
    });
  });

  describe("verifyWebhookSignature", () => {
    it("should verify valid webhook signature", () => {
      const body = '{"test": "data"}';
      const signature = "sha256=1234567890abcdef";
      
      // Mock the crypto module
      const mockCreateHmac = jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue("1234567890abcdef"),
      });
      
      jest.doMock("crypto", () => ({
        createHmac: mockCreateHmac,
      }));

      const result = agent.verifyWebhookSignature(body, signature);
      expect(result).toBe(true);
    });

    it("should reject invalid webhook signature", () => {
      const body = '{"test": "data"}';
      const signature = "sha256=invalid-signature";
      
      const mockCreateHmac = jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue("1234567890abcdef"),
      });
      
      jest.doMock("crypto", () => ({
        createHmac: mockCreateHmac,
      }));

      const result = agent.verifyWebhookSignature(body, signature);
      expect(result).toBe(false);
    });
  });

  describe("convertWhatsAppMessageToAGUI", () => {
    it("should convert text message correctly", () => {
      const whatsappMessage: WhatsAppMessage = {
        id: "test-message-id",
        from: "1234567890",
        timestamp: "1234567890",
        type: "text",
        text: {
          body: "Hello, world!",
        },
      };

      const result = (agent as any).convertWhatsAppMessageToAGUI(whatsappMessage);
      
      expect(result).toEqual({
        id: "test-message-id",
        role: "user",
        content: "Hello, world!",
        timestamp: expect.any(String),
      });
    });

    it("should convert image message correctly", () => {
      const whatsappMessage: WhatsAppMessage = {
        id: "test-message-id",
        from: "1234567890",
        timestamp: "1234567890",
        type: "image",
        image: {
          id: "image-id",
          mime_type: "image/jpeg",
          sha256: "abc123",
          caption: "Beautiful sunset",
        },
      };

      const result = (agent as any).convertWhatsAppMessageToAGUI(whatsappMessage);
      
      expect(result).toEqual({
        id: "test-message-id",
        role: "user",
        content: "[Image]: Beautiful sunset",
        timestamp: expect.any(String),
      });
    });

    it("should convert audio message correctly", () => {
      const whatsappMessage: WhatsAppMessage = {
        id: "test-message-id",
        from: "1234567890",
        timestamp: "1234567890",
        type: "audio",
        audio: {
          id: "audio-id",
          mime_type: "audio/ogg",
          sha256: "def456",
        },
      };

      const result = (agent as any).convertWhatsAppMessageToAGUI(whatsappMessage);
      
      expect(result).toEqual({
        id: "test-message-id",
        role: "user",
        content: "[Audio message]",
        timestamp: expect.any(String),
      });
    });
  });

  describe("processWebhook", () => {
    it("should extract messages from webhook data", () => {
      const webhookData = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "123456789",
            changes: [
              {
                value: {
                  messaging_product: "whatsapp",
                  metadata: {
                    display_phone_number: "+1234567890",
                    phone_number_id: "test-phone-number-id",
                  },
                  messages: [
                    {
                      id: "wamid.123456789",
                      from: "1234567890",
                      timestamp: "1234567890",
                      type: "text",
                      text: {
                        body: "Hello!",
                      },
                    },
                  ],
                },
                field: "messages",
              },
            ],
          },
        ],
      };

      const messages = agent.processWebhook(webhookData);
      
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        id: "wamid.123456789",
        from: "1234567890",
        timestamp: "1234567890",
        type: "text",
        text: {
          body: "Hello!",
        },
      });
    });

    it("should handle webhook with no messages", () => {
      const webhookData = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "123456789",
            changes: [
              {
                value: {
                  messaging_product: "whatsapp",
                  metadata: {
                    display_phone_number: "+1234567890",
                    phone_number_id: "test-phone-number-id",
                  },
                },
                field: "messages",
              },
            ],
          },
        ],
      };

      const messages = agent.processWebhook(webhookData);
      
      expect(messages).toHaveLength(0);
    });
  });
}); 