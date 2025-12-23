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
import { DEFINED_IN_MIDDLEWARE_EXPERIMENTAL } from "@ag-ui/client";

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
 * 4. Injects tool definitions via DEFINED_IN_MIDDLEWARE_EXPERIMENTAL (reduces duplication)
 *
 * Configuration used in this demo (see agents.ts):
 * - allowedTools: Declarative allowlist with ToolSpec objects (source of truth)
 * - isToolAllowed: Custom callback for additional validation logic
 * - onDeviation: Custom handler that logs when tool calls are blocked
 *
 * Features demonstrated:
 * - "change_background" uses DEFINED_IN_MIDDLEWARE_EXPERIMENTAL for description
 *   → The middleware injects the description from allowedTools
 * - "say_hello" is NOT in the allowlist → blocked by middleware
 *
 * Try asking the agent to:
 * - "Change the background to blue" (will succeed)
 * - "Say hello" (will be blocked by middleware - check server console)
 *
 * Note: Deviations are logged server-side via console.warn. Check your
 * terminal/server logs to see the security warnings when tools are blocked.
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
  // Using DEFINED_IN_MIDDLEWARE_EXPERIMENTAL to get description AND parameters from the server-side middleware.
  // This eliminates duplication - the middleware's allowedTools is the source of truth.
  //
  // Note: We use type assertions because CopilotKit's types expect specific formats,
  // but the middleware will replace these placeholders before the agent sees them.
  // TODO: Update CopilotKit types to natively accept DEFINED_IN_MIDDLEWARE_EXPERIMENTAL
  useFrontendTool(
    // Type assertion to bypass CopilotKit's strict parameter type checking
    // The middleware will replace DEFINED_IN_MIDDLEWARE_EXPERIMENTAL with actual values
    {
      name: "change_background",
      // Description comes from middleware's allowedTools config (see agents.ts)
      description: DEFINED_IN_MIDDLEWARE_EXPERIMENTAL,
      // Parameters also come from middleware
      parameters: DEFINED_IN_MIDDLEWARE_EXPERIMENTAL,
      handler: ({ background }: { background: string }) => {
        setBackground(background);
        return {
          status: "success",
          message: `Background changed to ${background}`,
        };
      },
    } as unknown as Parameters<typeof useFrontendTool>[0],
  );

  // This tool exists in frontend but is NOT in the middleware's allowedTools list
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
            • change_background: allowed (uses DEFINED_IN_MIDDLEWARE_EXPERIMENTAL) • say_hello: not in allowlist
          </span>
        </div>
        <div className="text-xs opacity-60 ml-7">
          ℹ️ Check server console for security logs and tool definition injection
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
