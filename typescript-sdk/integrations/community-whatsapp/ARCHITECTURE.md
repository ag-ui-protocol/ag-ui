# WhatsApp Integration Architecture

This document provides a comprehensive overview of the WhatsApp integration for AG-UI, explaining the architecture, components, and design decisions.

## 🏗️ Architecture Overview

The WhatsApp integration follows a modular, layered architecture designed for extensibility and maintainability:

```
┌─────────────────────────────────────────────────────────────┐
│                    Public API Layer                        │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │  WhatsAppAgent  │  │EnhancedWhatsApp │  │   Utils     │ │
│  │                 │  │     Agent       │  │             │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│                   Business Logic Layer                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ Message Handler │  │  Webhook Proc.  │  │ AI Provider │ │
│  │                 │  │                 │  │  Interface  │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│                    Data Layer                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ WhatsApp API    │  │  Message Conv.  │  │ Type Defs   │ │
│  │   Client        │  │                 │  │             │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## 📁 Directory Structure

```
src/
├── agents/                    # Core agent implementations
│   ├── whatsapp-agent.ts     # Basic WhatsApp agent
│   └── enhanced-whatsapp-agent.ts  # AI-powered agent
├── providers/                 # AI provider implementations
│   ├── openai-provider.ts    # OpenAI integration
│   ├── anthropic-provider.ts # Anthropic integration
│   └── index.ts              # Provider exports
├── types/                    # TypeScript type definitions
│   └── index.ts              # All interfaces and types
├── utils/                    # Utility functions
│   ├── webhook.ts            # Webhook processing utilities
│   ├── message-converter.ts  # Message format conversion
│   └── index.ts              # Utility exports
├── examples/                 # Usage examples
│   ├── basic-usage.ts        # Basic WhatsApp usage
│   ├── ai-integration.ts     # AI integration examples
│   └── express-server.ts     # Express.js server example
├── tests/                    # Test files
│   ├── simple-test.ts        # Basic functionality tests
│   ├── ai-test.ts           # AI functionality tests
│   └── whatsapp-agent.test.ts # Unit tests
└── index.ts                  # Main exports
```

## 🧩 Core Components

### 1. WhatsAppAgent (Base Agent)

**Purpose**: Provides basic WhatsApp Business API integration without AI capabilities.

**Key Features**:
- Webhook signature verification
- Message sending and receiving
- Message format conversion
- AG-UI event system integration

**Core Methods**:
```typescript
class WhatsAppAgent extends AbstractAgent {
  verifyWebhookSignature(body: string, signature: string): boolean
  processWebhook(body: WhatsAppWebhookEntry): WhatsAppMessage[]
  sendTextMessage(to: string, text: string): Promise<WhatsAppSendMessageResponse>
  convertWhatsAppMessageToAGUI(whatsappMessage: WhatsAppMessage): Message
  handleWebhook(body: string, signature: string): Promise<void>
}
```

### 2. EnhancedWhatsAppAgent (AI-Powered Agent)

**Purpose**: Extends the base agent with AI capabilities for intelligent responses.

**Key Features**:
- All features from WhatsAppAgent
- AI provider integration
- Configurable system prompts
- Dynamic AI parameter adjustment

**Core Methods**:
```typescript
class EnhancedWhatsAppAgent extends WhatsAppAgent {
  setAIProvider(provider: AIProvider | undefined): void
  setSystemPrompt(prompt: string): void
  setAIParameters(maxTokens: number, temperature: number): void
  handleWebhookWithAI(body: string, signature: string): Promise<void>
}
```

### 3. AI Providers

**Purpose**: Abstract AI service integrations for generating intelligent responses.

**Available Providers**:
- `OpenAIProvider`: Integration with OpenAI GPT models
- `AnthropicProvider`: Integration with Anthropic Claude models

**Interface**:
```typescript
interface AIProvider {
  generateResponse(messages: any[], context?: any): Promise<string>
}
```

### 4. Utilities

**Purpose**: Reusable functions for common operations.

**Webhook Utilities** (`utils/webhook.ts`):
- `verifyWebhookSignature()`: Verify WhatsApp webhook authenticity
- `processWebhook()`: Extract messages from webhook payload

**Message Conversion** (`utils/message-converter.ts`):
- `convertWhatsAppMessageToAGUI()`: Convert WhatsApp → AG-UI format
- `convertAGUIMessageToWhatsApp()`: Convert AG-UI → WhatsApp format

## 🔄 Data Flow

### 1. Incoming Message Flow

```
WhatsApp Webhook → verifyWebhookSignature() → processWebhook() → 
convertWhatsAppMessageToAGUI() → AG-UI Message → Agent Processing
```

### 2. Outgoing Message Flow

```
AG-UI Response → convertAGUIMessageToWhatsApp() → 
WhatsApp API → Message Delivered
```

### 3. AI-Enhanced Flow

```
Incoming Message → AI Provider → generateResponse() → 
Enhanced Response → WhatsApp API → Message Delivered
```

## 🛡️ Security Features

### Webhook Signature Verification

The integration implements HMAC-SHA256 signature verification to ensure webhook authenticity:

```typescript
function verifyWebhookSignature(body: string, signature: string, webhookSecret: string): boolean {
  const expectedSignature = createHmac("sha256", webhookSecret)
    .update(body)
    .digest("hex");
  
  return signature === `sha256=${expectedSignature}`;
}
```

### Configuration Security

- Access tokens are stored securely
- Webhook secrets are used for verification
- API credentials are validated before use

## 🔧 Message Type Support

The integration supports all major WhatsApp message types:

| WhatsApp Type | AG-UI Conversion | Description |
|---------------|------------------|-------------|
| `text` | Direct content | Plain text messages |
| `image` | `[Image]: caption` | Images with optional captions |
| `audio` | `[Audio message]` | Voice messages |
| `document` | `[Document: filename]` | File attachments |
| `video` | `[Video]: caption` | Video messages |
| `location` | `[Location: name at lat,lng]` | Location sharing |
| `contact` | `[Contact: name]` | Contact sharing |

## 🎯 Design Principles

### 1. Separation of Concerns
- **Agents**: Handle business logic and state management
- **Providers**: Abstract AI service integrations
- **Utils**: Provide reusable utility functions
- **Types**: Define clear interfaces and contracts

### 2. Extensibility
- Easy to add new AI providers
- Modular message type support
- Pluggable webhook handlers
- Configurable agent behavior

### 3. Type Safety
- Full TypeScript support
- Strict type checking
- Clear interface definitions
- Runtime type validation

### 4. Error Handling
- Graceful error recovery
- Detailed error messages
- Fallback mechanisms
- Logging and monitoring

## 🚀 Extension Points

### Adding New AI Providers

1. Implement the `AIProvider` interface:
```typescript
class CustomAIProvider implements AIProvider {
  async generateResponse(messages: any[], context?: any): Promise<string> {
    // Your AI integration logic
  }
}
```

2. Export from providers:
```typescript
// src/providers/custom-provider.ts
export class CustomAIProvider implements AIProvider { ... }

// src/providers/index.ts
export * from "./custom-provider";
```

### Adding New Message Types

1. Extend the `WhatsAppMessage` interface
2. Update the conversion utilities
3. Add type-specific handling logic

### Custom Webhook Handlers

1. Extend the base agent class
2. Override webhook processing methods
3. Add custom business logic

## 📊 Performance Considerations

### Memory Management
- Efficient message conversion
- Minimal object allocation
- Proper cleanup of resources

### API Rate Limiting
- Respect WhatsApp API limits
- Implement retry logic
- Handle rate limit errors gracefully

### Caching Strategy
- Cache AI responses when appropriate
- Store conversation context
- Optimize repeated operations

## 🔍 Testing Strategy

### Unit Tests
- Individual component testing
- Mock external dependencies
- Validate type safety

### Integration Tests
- End-to-end webhook testing
- AI provider integration
- Message flow validation

### Performance Tests
- Load testing webhook handling
- AI response time measurement
- Memory usage monitoring

## 📈 Monitoring and Observability

### Key Metrics
- Webhook processing time
- Message delivery success rate
- AI response generation time
- Error rates and types

### Logging
- Structured logging for debugging
- Error tracking and alerting
- Performance monitoring
- Security event logging

## 🔮 Future Enhancements

### Planned Features
- Media message handling
- Message templates
- Typing indicators
- Message status tracking
- Multi-language support

### Potential Integrations
- Additional AI providers
- Analytics platforms
- CRM integrations
- Custom business logic hooks

---

This architecture provides a solid foundation for WhatsApp integration while maintaining flexibility for future enhancements and customizations. 