import { WhatsAppAgent } from "./whatsapp-agent";
import { WhatsAppAgentConfig, AIProvider } from "../types";

export interface EnhancedWhatsAppAgentConfig extends WhatsAppAgentConfig {
  aiProvider?: AIProvider;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export class EnhancedWhatsAppAgent extends WhatsAppAgent {
  private aiProvider?: AIProvider;
  private systemPrompt: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: EnhancedWhatsAppAgentConfig) {
    super(config);
    this.aiProvider = config.aiProvider;
    this.systemPrompt = config.systemPrompt || "You are a helpful WhatsApp assistant. Respond naturally and concisely.";
    this.maxTokens = config.maxTokens || 150;
    this.temperature = config.temperature || 0.7;
  }

  /**
   * Generate AI response using the configured AI provider
   */
  private async generateAIResponse(messages: any[]): Promise<string> {
    if (!this.aiProvider) {
      // Fallback to simple echo response
      const lastMessage = messages[messages.length - 1];
      return `I received your message: "${lastMessage.content}". This is a demo response.`;
    }

    try {
      const response = await this.aiProvider.generateResponse(messages, {
        systemPrompt: this.systemPrompt,
        maxTokens: this.maxTokens,
        temperature: this.temperature,
      });
      
      return response;
    } catch (error) {
      console.error("Error generating AI response:", error);
      return "I'm sorry, I'm having trouble processing your request right now. Please try again later.";
    }
  }

  /**
   * Override the run method to use AI for generating responses
   */
  protected async runWithAI(input: any): Promise<any> {
    // Convert messages to AI format
    const aiMessages = input.messages.map((msg: any) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Add system message
    aiMessages.unshift({
      role: "system",
      content: this.systemPrompt,
    });

    // Generate AI response
    const aiResponse = await this.generateAIResponse(aiMessages);

    return {
      messages: [
        {
          role: "assistant",
          content: aiResponse,
        },
      ],
    };
  }

  /**
   * Enhanced webhook handler with AI integration
   */
  async handleWebhookWithAI(body: string, signature: string): Promise<void> {
    // Verify webhook signature
    if (!this.verifyWebhookSignature(body, signature)) {
      throw new Error("Invalid webhook signature");
    }

    const webhookData = JSON.parse(body);
    const messages = this.processWebhook(webhookData);

    // Process each message
    for (const whatsappMessage of messages) {
      const aguiMessage = this.convertWhatsAppMessageToAGUI(whatsappMessage);
      this.addMessage(aguiMessage);

      // Generate AI response
      const aiResult = await this.runWithAI({
        messages: (this as any).messages,
      });

      // Send the AI-generated response back to WhatsApp
      if (aiResult.messages && aiResult.messages.length > 0) {
        const responseMessage = aiResult.messages[0];
        await this.sendTextMessage(whatsappMessage.from, responseMessage.content);
      }
    }
  }

  /**
   * Set AI provider
   */
  setAIProvider(provider: AIProvider | undefined): void {
    this.aiProvider = provider;
  }

  /**
   * Update system prompt
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /**
   * Update AI parameters
   */
  setAIParameters(maxTokens: number, temperature: number): void {
    this.maxTokens = maxTokens;
    this.temperature = temperature;
  }
} 