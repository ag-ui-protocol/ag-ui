# WhatsApp Integration for AG-UI

This integration allows you to use AG-UI with WhatsApp Business API to create conversational AI agents that can interact with users through WhatsApp.

## 📚 Tutorial: Getting Started with WhatsApp Business API

Before using this integration, you need to set up WhatsApp Business API. Follow these steps:

### Step 1: Create a Meta Developer Account

1. Go to [Meta for Developers](https://developers.facebook.com/)
2. Create a new app or use an existing one
3. Add the **WhatsApp** product to your app

### Step 2: Set Up WhatsApp Business API

1. **Navigate to WhatsApp** in your Meta app dashboard
2. **Get Started** with WhatsApp Business API
3. **Add a Phone Number**:
   - Click "Add phone number"
   - Enter your business phone number
   - Verify the number via SMS/call
   - Note down the **Phone Number ID** (you'll need this)

### Step 3: Generate Access Token

1. Go to **System Users** in your Meta app
2. Create a new system user or use existing one
3. **Generate Access Token**:
   - Select your system user
   - Click "Generate Token"
   - Choose "WhatsApp Business API" permissions
   - Copy the **Access Token** (keep it secure!)

### Step 4: Configure Webhook

1. **Set up your webhook endpoint** (e.g., `https://your-domain.com/webhook`)
2. **Configure webhook in Meta**:
   - Go to WhatsApp → Configuration
   - Add your webhook URL
   - Set **Webhook Secret** (create a strong secret)
   - Subscribe to these fields:
     - `messages`
     - `message_status`
     - `message_template_status`

### Step 5: Test Your Setup

Use the [WhatsApp Business API Testing Guide](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started) to verify your configuration.

### 🔗 Helpful Resources

- [WhatsApp Business API Documentation](https://developers.facebook.com/docs/whatsapp)
- [Webhook Setup Guide](https://developers.facebook.com/docs/whatsapp/webhook)
- [Message Templates](https://developers.facebook.com/docs/whatsapp/message-templates)
- [API Reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference)

## 🚀 Installation

```bash
npm install @ag-ui/community-whatsapp
```

## 💡 Basic Usage

```typescript
import { WhatsAppAgent } from "@ag-ui/community-whatsapp";

const agent = new WhatsAppAgent({
  phoneNumberId: "your-phone-number-id",    // From Step 2
  accessToken: "your-access-token",         // From Step 3
  webhookSecret: "your-webhook-secret",     // From Step 4
  threadId: "conversation-id",
});

// Handle incoming webhook
await agent.handleWebhook(webhookBody, signature);

// Send a message
await agent.sendMessageToNumber("1234567890", "Hello from AG-UI!");
```

## 🤖 Enhanced Usage with AI Integration

```typescript
import { EnhancedWhatsAppAgent, OpenAIProvider } from "@ag-ui/community-whatsapp";

// Create AI provider
const openAIProvider = new OpenAIProvider("your-openai-api-key");

// Create enhanced agent
const agent = new EnhancedWhatsAppAgent({
  phoneNumberId: "your-phone-number-id",
  accessToken: "your-access-token",
  webhookSecret: "your-webhook-secret",
  aiProvider: openAIProvider,
  systemPrompt: "You are a helpful customer service assistant.",
  maxTokens: 200,
  temperature: 0.7,
});

// Handle webhook with AI responses
await agent.handleWebhookWithAI(webhookBody, signature);
```

## ⚙️ Configuration

### Basic Configuration
- `phoneNumberId`: Your WhatsApp Business API phone number ID (from Step 2)
- `accessToken`: Your WhatsApp Business API access token (from Step 3)
- `webhookSecret`: Secret for verifying webhook requests (from Step 4)
- `apiVersion`: WhatsApp API version (default: "v23.0")

### Enhanced Configuration
- `aiProvider`: AI service provider (OpenAI, Anthropic, etc.)
- `systemPrompt`: System prompt for AI responses
- `maxTokens`: Maximum tokens for AI responses
- `temperature`: AI response creativity (0.0-1.0)

## ✨ Features

### Core Features
- ✅ Send and receive WhatsApp messages
- ✅ Handle media messages (images, audio, documents)
- ✅ Webhook verification with HMAC-SHA256
- ✅ Message status tracking
- ✅ Typing indicators
- ✅ Message templates

### AI Integration Features
- ✅ OpenAI GPT integration
- ✅ Anthropic Claude integration
- ✅ Custom AI provider support
- ✅ Dynamic AI provider switching
- ✅ Configurable system prompts
- ✅ Adjustable AI parameters

## 📖 Examples

### Express.js Server
```typescript
import { createExpressServer } from "@ag-ui/community-whatsapp";

const app = createExpressServer();
app.listen(3000, () => {
  console.log("WhatsApp server running on port 3000");
});
```

### Environment-based Configuration
```typescript
import { createAgentFromEnv } from "@ag-ui/community-whatsapp";

const agent = createAgentFromEnv();
```

## 🤖 AI Providers

### OpenAI
```typescript
import { OpenAIProvider } from "@ag-ui/community-whatsapp";

const openAIProvider = new OpenAIProvider("your-api-key", "gpt-4");
```

### Anthropic Claude
```typescript
import { AnthropicProvider } from "@ag-ui/community-whatsapp";

const anthropicProvider = new AnthropicProvider("your-api-key", "claude-3-sonnet-20240229");
```

## 🔧 Quick Test

Test your setup with our simple test:

```bash
npx tsx src/tests/simple-test.ts
```

## 📚 Documentation

- [Architecture Documentation](./ARCHITECTURE.md) - Detailed technical overview
- [API Reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference)
- [Webhook Guide](https://developers.facebook.com/docs/whatsapp/webhook)

## 🤝 Contributing

This is a community integration. Contributions are welcome!

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## 📄 License

MIT
