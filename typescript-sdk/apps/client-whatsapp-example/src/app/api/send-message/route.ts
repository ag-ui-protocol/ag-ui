import { NextRequest, NextResponse } from "next/server";
import { WhatsAppAgent } from "@/lib/whatsapp-agent";
import { getConfig } from "@/lib/config";

export async function POST(request: NextRequest) {
  try {
    console.log("Send message API called");
    const config = getConfig();
    console.log("Config retrieved:", config ? "exists" : "null");

    if (!config) {
      console.log("No configuration found, returning error");
      return NextResponse.json(
        { 
          error: "WhatsApp configuration not found. Please configure your settings first.",
          details: "Missing or invalid configuration"
        },
        { status: 500 }
      );
    }

    console.log("Creating WhatsApp agent with config");
    console.log("Phone Number ID:", config.phoneNumberId);
    console.log("Has Access Token:", !!config.accessToken);
    console.log("Has Webhook Secret:", !!config.webhookSecret);

    const agent = new WhatsAppAgent({
      phoneNumberId: config.phoneNumberId,
      accessToken: config.accessToken,
      webhookSecret: config.webhookSecret,
    });

    const { phoneNumber, message } = await request.json();
    console.log("Sending message to:", phoneNumber);
    console.log("Message content:", message);

    if (!phoneNumber || !message) {
      return NextResponse.json(
        { 
          error: "phoneNumber and message are required",
          details: "Missing required fields"
        },
        { status: 400 }
      );
    }

    console.log("Calling sendMessageToNumber");
    try {
      const response = await agent.sendMessageToNumber(phoneNumber, message);
      console.log("Message sent successfully:", response.messages[0].id);

      return NextResponse.json({
        success: true,
        messageId: response.messages[0].id,
        response,
      });
    } catch (sendError) {
      console.error("Detailed send error:", {
        error: sendError,
        message: sendError instanceof Error ? sendError.message : 'Unknown error',
        stack: sendError instanceof Error ? sendError.stack : undefined
      });

      // Enhanced error response with detailed information
      const errorMessage = sendError instanceof Error ? sendError.message : 'Unknown error';
      
      return NextResponse.json(
        {
          error: "Failed to send WhatsApp message",
          details: errorMessage,
          status: 500,
          response: {
            error: errorMessage,
            type: "WhatsApp API Error",
            timestamp: new Date().toISOString()
          }
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Send message error:", error);
    return NextResponse.json(
      { 
        error: "Failed to send message",
        details: "Unexpected server error",
        status: 500
      },
      { status: 500 }
    );
  }
} 