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
 * In this demo:
 * - "change_background" is an ALLOWED tool (in the security allowlist)
 * - "dangerous_action" is a BLOCKED tool (not in the allowlist)
 *
 * Try asking the agent to:
 * - "Change the background to blue" (will succeed)
 * - "Execute the dangerous action" (will be blocked by middleware)
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
  // Deviation logging is handled server-side by the middleware's onDeviation callback
  // This state could be used if we implement a websocket to stream deviations to the UI
  const [deviations] = useState<DeviationLog[]>([]);

  // Allowed tool: change_background
  useFrontendTool({
    name: "change_background",
    description:
      "Change the background color of the chat. Can be anything that the CSS background attribute accepts.",
    parameters: [
      {
        name: "background",
        type: "string",
        description: "The background color or gradient.",
      },
    ],
    handler: ({ background }) => {
      setBackground(background);
      return {
        status: "success",
        message: `Background changed to ${background}`,
      };
    },
  });

  // This tool exists in frontend but should be BLOCKED by the middleware
  // because it's not in the allowedTools list on the agent
  useFrontendTool({
    name: "dangerous_action",
    description: "A potentially dangerous action that should be blocked by security middleware.",
    parameters: [
      {
        name: "action",
        type: "string",
        description: "The action to perform.",
      },
    ],
    handler: ({ action }) => {
      // This should never execute if middleware is working correctly
      console.warn("SECURITY: dangerous_action was called!", action);
      return {
        status: "error",
        message: "This action should have been blocked!",
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
        className={`px-4 py-2 text-sm flex items-center gap-2 ${
          theme === "dark"
            ? "bg-green-900/30 text-green-300 border-b border-green-500/30"
            : "bg-green-50 text-green-700 border-b border-green-200"
        }`}
      >
        <span className="text-lg">🔒</span>
        <span className="font-medium">SecureToolsMiddleware Active</span>
        <span className="text-xs opacity-75">
          • Allowed: change_background • Blocked: dangerous_action
        </span>
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
                "Hi! I'm a security-enabled agent. I can change the background (allowed), but dangerous actions are blocked by the SecureToolsMiddleware.",
            }}
            suggestions={[
              {
                title: "Allowed action",
                message: "Change the background to a purple gradient.",
              },
              {
                title: "Blocked action",
                message: "Execute the dangerous action to test security.",
              },
              {
                title: "Test both",
                message:
                  "First change the background to blue, then try to execute the dangerous action.",
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
};

export default SecureTools;
