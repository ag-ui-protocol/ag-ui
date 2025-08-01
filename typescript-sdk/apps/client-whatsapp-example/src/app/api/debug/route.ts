import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";

export async function GET() {
  try {
    console.log("Debug API called");
    const config = getConfig();
    
    if (!config) {
      return NextResponse.json({
        error: "No configuration found",
        config: null
      });
    }

    // Test the WhatsApp API credentials
    const testUrl = `https://graph.facebook.com/v18.0/${config.phoneNumberId}`;
    console.log("Testing WhatsApp API with URL:", testUrl);
    
    const response = await fetch(testUrl, {
      headers: {
        'Authorization': `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const responseData = await response.json();
    console.log("WhatsApp API Response:", responseData);

    if (!response.ok) {
      return NextResponse.json({
        error: "WhatsApp API test failed",
        status: response.status,
        statusText: response.statusText,
        response: responseData,
        config: {
          phoneNumberId: config.phoneNumberId,
          hasAccessToken: !!config.accessToken,
          hasWebhookSecret: !!config.webhookSecret,
          hasVerifyToken: !!config.verifyToken,
        }
      });
    }

    return NextResponse.json({
      success: true,
      message: "WhatsApp API credentials are valid",
      phoneNumberInfo: responseData,
      config: {
        phoneNumberId: config.phoneNumberId,
        hasAccessToken: !!config.accessToken,
        hasWebhookSecret: !!config.webhookSecret,
        hasVerifyToken: !!config.verifyToken,
      }
    });

  } catch (error) {
    console.error("Debug API error:", error);
    return NextResponse.json({
      error: "Debug API failed",
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
} 