import { NextRequest, NextResponse } from "next/server";
import { getConfig, setConfig } from "@/lib/config";

export async function GET() {
  try {
    console.log("Config GET API called");
    const config = getConfig();
    console.log("Config from getConfig:", config ? "exists" : "null");
    
    if (!config) {
      console.log("No configuration found, returning 404");
      return NextResponse.json({ error: "No configuration found" }, { status: 404 });
    }

    // Return configuration without sensitive data
    const response = {
      phoneNumberId: config.phoneNumberId,
      hasAccessToken: !!config.accessToken,
      hasWebhookSecret: !!config.webhookSecret,
      hasVerifyToken: !!config.verifyToken,
    };
    console.log("Returning config status:", response);
    return NextResponse.json(response);
  } catch (error) {
    console.error("Config GET error:", error);
    return NextResponse.json(
      { error: "Failed to retrieve configuration" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    console.log("Config POST API called");
    const config = await request.json();
    console.log("Received config data:", {
      phoneNumberId: config.phoneNumberId ? "provided" : "missing",
      hasAccessToken: !!config.accessToken,
      hasWebhookSecret: !!config.webhookSecret,
      hasVerifyToken: !!config.verifyToken,
    });

    // Validate required fields
    if (!config.phoneNumberId || !config.accessToken || !config.webhookSecret || !config.verifyToken) {
      console.log("Missing required fields");
      return NextResponse.json(
        { error: "All fields are required" },
        { status: 400 }
      );
    }

    // Store configuration (in production, this would be in a secure database)
    setConfig(config);
    console.log("Configuration saved successfully");

    return NextResponse.json({
      success: true,
      message: "Configuration saved successfully",
    });
  } catch (error) {
    console.error("Config POST error:", error);
    return NextResponse.json(
      { error: "Failed to save configuration" },
      { status: 500 }
    );
  }
} 