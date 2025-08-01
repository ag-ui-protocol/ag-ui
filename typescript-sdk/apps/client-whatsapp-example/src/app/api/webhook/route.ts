import { NextRequest, NextResponse } from "next/server";
import { WhatsAppAgent } from "@ag-ui/community-whatsapp";
import { getConfig } from "@/lib/config";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  console.log("Webhook verification request:", { mode, token, challenge });

  const config = getConfig();
  if (!config) {
    console.log("No configuration found for webhook verification");
    return NextResponse.json({ error: "Configuration not found" }, { status: 500 });
  }

  if (mode === "subscribe" && token === config.verifyToken) {
    console.log("Webhook verified successfully");
    return new NextResponse(challenge, { status: 200 });
  }

  console.log("Webhook verification failed");
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function POST(request: NextRequest) {
  try {
    console.log("Webhook POST received");
    const config = getConfig();
    
    if (!config) {
      console.log("No configuration found for webhook processing");
      return NextResponse.json({ error: "Configuration not found" }, { status: 500 });
    }

    const agent = new WhatsAppAgent({
      phoneNumberId: config.phoneNumberId,
      accessToken: config.accessToken,
      webhookSecret: config.webhookSecret,
    });

    const body = await request.text();
    console.log("Webhook body:", body);

    // Verify webhook signature
    const signature = request.headers.get("x-hub-signature-256");
    if (!signature || !agent.verifyWebhookSignature(body, signature)) {
      console.log("Webhook signature verification failed");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Process webhook
    const webhookData = JSON.parse(body);
    const processedMessages = await agent.processWebhook(webhookData);

    console.log("Webhook processed successfully:", processedMessages);
    return NextResponse.json({ 
      success: true, 
      processedMessages 
    });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
} 