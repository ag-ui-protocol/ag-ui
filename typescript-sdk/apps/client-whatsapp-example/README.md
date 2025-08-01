# AG-UI WhatsApp Example

A Next.js demonstration application showcasing AG-UI's WhatsApp Business API integration. This example shows how to build a web application that can send WhatsApp messages and receive webhooks.

## Features

- **WhatsApp Business API Integration**: Send messages using the WhatsApp Business API
- **Web-based Configuration**: Secure configuration interface for WhatsApp credentials
- **Debug Tools**: Built-in debugging tools to test API credentials
- **Webhook Support**: Receive and process incoming WhatsApp messages
- **Modern UI**: Clean, responsive interface built with Next.js and Tailwind CSS

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Styling**: Tailwind CSS
- **WhatsApp Integration**: AG-UI Community WhatsApp Package
- **Language**: TypeScript
- **Deployment**: Vercel-ready

## Prerequisites

- Node.js 18+ 
- WhatsApp Business API account
- Meta Developer Console access

## Quick Start

1. **Install dependencies**:
   ```bash
   pnpm install
   ```

2. **Run the development server**:
   ```bash
   pnpm dev
   ```

3. **Open your browser**:
   Navigate to [http://localhost:3000](http://localhost:3000)

## WhatsApp Business API Setup

### 1. Create WhatsApp Business API App

1. Go to [Meta Developer Console](https://developers.facebook.com/)
2. Create a new app or use an existing one
3. Add the **WhatsApp Business API** product
4. Configure your phone number

### 2. Get Your Credentials

You'll need these values from your Meta Developer Console:

- **Phone Number ID**: Found in WhatsApp Business API → Phone Numbers
- **Access Token**: Generated from System Users → Generate Token
- **Webhook Secret**: Create a strong secret for webhook verification
- **Verify Token**: Any string for webhook verification challenges

### 3. Configure the App

1. Open the app in your browser
2. Click **"Configure"** in the top right
3. Enter your WhatsApp Business API credentials
4. Save the configuration

### 4. Test the Integration

1. **Debug Credentials**: Click "Debug Credentials" to test your setup
2. **Send Messages**: Use the form to send test messages
3. **Check Webhooks**: Configure your webhook URL in Meta Developer Console

## Project Structure

```
client-whatsapp-example/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── config/          # Configuration management
│   │   │   ├── debug/           # Debug API endpoint
│   │   │   ├── send-message/    # Send WhatsApp messages
│   │   │   └── webhook/         # Receive webhooks
│   │   ├── config/              # Configuration page
│   │   └── page.tsx             # Main application page
│   └── lib/
│       └── config.ts            # Configuration utilities
├── public/                      # Static assets
└── README.md                    # This file
```

## API Endpoints

### Configuration Management
- `GET /api/config` - Get current configuration status
- `POST /api/config` - Save new configuration

### WhatsApp Integration
- `POST /api/send-message` - Send WhatsApp message
- `GET/POST /api/webhook` - Handle WhatsApp webhooks

### Debug Tools
- `GET /api/debug` - Test WhatsApp API credentials

## Environment Variables

Create a `.env.local` file with your WhatsApp credentials:

```env
# WhatsApp Business API Configuration
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id_here
WHATSAPP_ACCESS_TOKEN=your_access_token_here
WHATSAPP_WEBHOOK_SECRET=your_webhook_secret_here
WHATSAPP_VERIFY_TOKEN=your_verify_token_here
```

## Deployment

### Vercel Deployment

1. **Push to GitHub**:
   ```bash
   git add .
   git commit -m "Add WhatsApp example app"
   git push origin main
   ```

2. **Deploy to Vercel**:
   - Connect your GitHub repository to Vercel
   - Add environment variables in Vercel dashboard
   - Deploy automatically

### Environment Variables in Production

Set these in your Vercel dashboard:
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_WEBHOOK_SECRET`
- `WHATSAPP_VERIFY_TOKEN`

## Security Notes

- **Demo Configuration**: This example uses file-based storage for demo purposes
- **Production**: Use secure environment variables or a database
- **Webhook Security**: Always verify webhook signatures in production
- **Access Tokens**: Keep your access tokens secure and rotate regularly

## Troubleshooting

### Common Issues

1. **"Phone Number ID does not exist"**
   - Verify your Phone Number ID in Meta Developer Console
   - Check that your access token has the right permissions

2. **"Missing permissions"**
   - Ensure your access token has `whatsapp_business_messaging` permission
   - Check that you're using the correct Phone Number ID

3. **"Webhook verification failed"**
   - Verify your webhook secret matches in both places
   - Check that your webhook URL is accessible

### Debug Tools

Use the built-in debug tools to:
- Test your WhatsApp API credentials
- Verify your Phone Number ID
- Check API permissions
- Validate webhook configuration

## Contributing

This is part of the AG-UI project. To contribute:

1. Fork the AG-UI repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

This example is part of the AG-UI project and follows the same license terms.

## Related Links

- [AG-UI Documentation](https://docs.ag-ui.com)
- [WhatsApp Business API Documentation](https://developers.facebook.com/docs/whatsapp)
- [Meta Developer Console](https://developers.facebook.com/)
- [Next.js Documentation](https://nextjs.org/docs) 