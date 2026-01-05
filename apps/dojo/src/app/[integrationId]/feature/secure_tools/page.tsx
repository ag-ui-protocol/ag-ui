"use client";
import React, { useState } from "react";
import "@copilotkit/react-ui/styles.css";
import "./style.css";
import {
  CopilotKit,
  useFrontendTool,
} from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";
import { useTheme } from "next-themes";
import { getV1xToolConfig, type SecureToolArgs } from "@/lib/secure-tools";

interface SecureToolsProps {
  params: Promise<{
    integrationId: string;
  }>;
}

/**
 * Secure Tools Demo
 *
 * This demo showcases the SecureToolsMiddleware which provides security
 * validation for agent tool calls. The middleware:
 *
 * 1. Validates tool calls against full specifications (not just names)
 * 2. Blocks unauthorized or mismatched tool calls
 * 3. Logs deviations for audit purposes
 *
 * All tool specs are defined in a single file: @/lib/secure-tools.ts
 * Both client and server import from this file, ensuring consistency.
 *
 * Features demonstrated:
 * - "change_background" is in the specs → allowed
 * - "say_hello" is NOT in the specs → blocked by middleware
 *
 * Try asking the agent to:
 * - "Change the background to blue" (will succeed)
 * - "Say hello" (will be blocked by middleware - check server console)
 */
const SecureTools: React.FC<SecureToolsProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="secure_tools"
    >
      <Chat />
    </CopilotKit>
  );
};

interface DeviationLog {
  id: string;
  timestamp: Date;
  toolName: string;
  reason: string;
  message: string;
}

const Chat = () => {
  const { theme } = useTheme();
  const [background, setBackground] = useState<string>("var(--copilot-kit-background-color)");
  const [deviations] = useState<DeviationLog[]>([]);

  // Get tool config from shared specs (single source of truth)
  const changeBackgroundConfig = getV1xToolConfig("change_background");

  // Allowed tool: change_background
  // Using getV1xToolConfig to get description and parameters from the shared specs.
  // The middleware uses the same specs via getMiddlewareConfig().
  useFrontendTool({
    ...changeBackgroundConfig,
    // v1.x useFrontendTool doesn't infer handler args from parameters,
    // so we cast args to our known type for type safety
    handler: (args) => {
      const { background } = args as SecureToolArgs<"change_background">;
      setBackground(background);
      return {
        status: "success",
        message: `Background changed to ${background}`,
      };
    },
  });

  // This tool exists in frontend but is NOT in the shared specs
  // The middleware will block any attempts to call it
  useFrontendTool({
    name: "say_hello",
    description: "Say hello. A friendly greeting tool.",
    parameters: [],
    handler: () => {
      return {
        status: "success",
        message: "Hello! 👋",
      };
    },
  });

  return (
    <div
      className="flex flex-col h-full w-full"
      style={{ background }}
    >
      {/* Security Status Banner */}
      <div
        className={`px-4 py-2 text-sm flex flex-col gap-1 ${
          theme === "dark"
            ? "bg-green-900/30 text-green-300 border-b border-green-500/30"
            : "bg-green-50 text-green-700 border-b border-green-200"
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">🔒</span>
          <span className="font-medium">SecureToolsMiddleware Active</span>
          <span className="text-xs opacity-75">
            • change_background: allowed (via shared specs) • say_hello: not in specs
          </span>
        </div>
        <div className="text-xs opacity-60 ml-7">
          ℹ️ Check server console for security logs
        </div>
      </div>

      {/* Deviation Log Panel */}
      {deviations.length > 0 && (
        <div
          className={`px-4 py-2 text-sm ${
            theme === "dark"
              ? "bg-red-900/20 text-red-300 border-b border-red-500/30"
              : "bg-red-50 text-red-700 border-b border-red-200"
          }`}
        >
          <div className="font-medium mb-1">⚠️ Security Deviations Detected:</div>
          {deviations.map((d) => (
            <div key={d.id} className="text-xs opacity-90 ml-4">
              • [{d.timestamp.toLocaleTimeString()}] Tool "{d.toolName}" blocked: {d.reason}
            </div>
          ))}
        </div>
      )}

      {/* Chat Area */}
      <div className="flex-1 flex justify-center items-center">
        <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <CopilotChat
            className="h-full rounded-2xl max-w-6xl mx-auto"
            labels={{
              initial:
                "Hi! I'm an agent with two tools available: I can change the background color, and I can say hello to people.",
            }}
            suggestions={[
              {
                title: "Change background",
                message: "Change the background to a purple gradient.",
              },
              {
                title: "Say hello",
                message: "Say hello.",
              },
              {
                title: "Try both",
                message: "Change the background to blue and then say hello.",
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
};

export default SecureTools;
