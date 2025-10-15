# Cloudflare AG-UI Examples Server

This server provides AG-UI endpoints using Cloudflare Workers AI models.

## Setup

1. Copy `.env.example` to `.env` and fill in your Cloudflare credentials:
   ```bash
   cp .env.example .env
   ```

2. Get your Cloudflare credentials:
   - Account ID: Found in Cloudflare dashboard
   - API Token: Create one at https://dash.cloudflare.com/profile/api-tokens
     - Use "Workers AI" template or create custom with "Workers AI:Read" permission

3. Install dependencies:
   ```bash
   pnpm install
   ```

4. Run the server:
   ```bash
   pnpm start
   ```

## Available Agents

- `POST /agentic_chat` - Basic chat agent using Llama 3.1 8B

## Environment Variables

- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID (required)
- `CLOUDFLARE_API_TOKEN` - Your Cloudflare API token (required)
- `PORT` - Server port (default: 4114)
- `HOST` - Server host (default: 0.0.0.0)
