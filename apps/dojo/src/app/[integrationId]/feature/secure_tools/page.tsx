"use client";
import React, { useState, useEffect, useRef } from "react";
import "@copilotkit/react-ui/styles.css";
import "./style.css";
import {
  CopilotKit,
  useCopilotChat,
  useFrontendTool,
} from "@copilotkit/react-core";
import { CopilotChat, RenderSuggestion } from "@copilotkit/react-ui";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

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
 * 4. Streams security deviations as CUSTOM events for frontend tracking
 *
 * Configuration used in this demo (see agents.ts):
 * - allowedTools: Declarative allowlist with ToolSpec objects
 * - isToolAllowed: Custom callback for additional validation logic
 * - onDeviation: Custom handler that logs when tool calls are blocked
 * - blockedToolMessage: Custom message formatter for blocked tools
 *
 * In this demo:
 * - "change_background" is an ALLOWED tool (in the security allowlist)
 * - "say_hello" is NOT in the allowlist (will be blocked by middleware)
 *
 * Try asking the agent to:
 * - "Change the background to blue" (will succeed)
 * - "Say hello" (will be blocked by middleware - see deviation panel)
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
  timestamp: number;
  toolName: string;
  reason: string;
}

const CHAT_ID = "secure-tools-chat";

const Chat = () => {
  const { theme } = useTheme();
  const [background, setBackground] = useState<string>("var(--copilot-kit-background-color)");
  const [deviations, setDeviations] = useState<DeviationLog[]>([]);
  const processedIds = useRef<Set<string>>(new Set());
  
  // Get messages from useCopilotChat with matching ID
  const { visibleMessages, isLoading } = useCopilotChat({ id: CHAT_ID });
  
  // Debug log - only log when values change
  useEffect(() => {
    console.log("[SecureTools] visibleMessages updated:", visibleMessages?.length, visibleMessages);
  }, [visibleMessages]);
  
  useEffect(() => {
    console.log("[SecureTools] isLoading:", isLoading);
  }, [isLoading]);

  // Detect blocked tool messages
  useEffect(() => {
    if (!visibleMessages || visibleMessages.length === 0) return;

    console.log("[SecureTools] Processing messages:", visibleMessages.length);
    
    for (const message of visibleMessages) {
      const msg = message as { id?: string; content?: string };
      const msgId = msg.id;
      if (!msgId) continue;

      console.log("[SecureTools] Message ID:", msgId, "Content:", msg.content?.substring(0, 50));

      // Check if this is a blocked message we haven't processed yet
      if (msgId.startsWith("blocked-msg-") && !processedIds.current.has(msgId)) {
        processedIds.current.add(msgId);

        const content = msg.content ?? "";
        const toolNameMatch = content.match(/tool "([^"]+)"/i);
        const toolName = toolNameMatch?.[1] ?? "unknown";

        setDeviations((prev) => [
          ...prev,
          {
            id: msgId,
            timestamp: Date.now(),
            toolName,
            reason: "NOT_IN_ALLOWLIST",
          },
        ]);
      }
    }
  }, [visibleMessages]);

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
            ? "bg-green-900/30 text-sky-300 border-b border-sky-500/30"
            : "bg-sky-50 text-sky-700 border-b border-sky-200"
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">🔒</span>
          <span className="font-medium">SecureToolsMiddleware Active</span>
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
              • [{new Date(d.timestamp).toLocaleTimeString()}] Tool &quot;{d.toolName}&quot; blocked: {d.reason}
            </div>
          ))}
        </div>
      )}

      {/* Chat Area */}
      <div className="flex-1 flex justify-center items-center">
        <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <CopilotChat
            className={cn(
              "h-full rounded-2xl max-w-6xl mx-auto",
              "[&_button.suggestion:nth-of-type(2)]:text-red-500",
            )}
            labels={{
              initial:
                "Hi! I'm an agent with two tools available: I can change the background color, and I can say hello to people.",
            }}
            RenderSuggestionsList={function Suggestions({
              suggestions,
              onSuggestionClick,
              isLoading,
            }) {
              return (
                <div className="suggestions">
                  {suggestions.map(({ title, message, isLoading, partial, className }) => (
                    <RenderSuggestion
                      key={title}
                      title={title}
                      message={message}
                      partial={isLoading ?? partial ?? isLoading}
                      className={`suggestion ${partial ? "loading" : ''} ${cn(
                        className,
                        title.includes("(not allowed)") && "text-red-700! border-red-600/25! bg-red-50!",
                        title.includes("(allowed)") && "text-green-700! border-green-600/25! bg-green-50!",
                      )}`}
                      onClick={() => onSuggestionClick(message)}
                    />
                  ))}
                </div>
              );
            }}
            suggestions={[
              {
                title: "Change background (allowed)",
                message: "Change the background to a purple gradient.",
              },
              {
                title: "Say hello (not allowed)",
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
