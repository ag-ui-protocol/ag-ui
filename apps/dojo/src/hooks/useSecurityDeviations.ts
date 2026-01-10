"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useCopilotChat } from "@copilotkit/react-core";
import type { SecurityDeviationEventPayload } from "@ag-ui/client";

/**
 * Hook to track security deviation events from the SecureToolsMiddleware.
 * 
 * This hook detects blocked tool messages by looking for assistant messages
 * with IDs starting with "blocked-msg-". The middleware emits these messages
 * when a tool call is blocked.
 * 
 * Note: In future CopilotKit versions that support the v2 API with custom events,
 * this hook can be updated to subscribe directly to SECURITY_DEVIATION_EVENT
 * custom events for a cleaner implementation.
 * 
 * @example
 * ```tsx
 * function SecurityPanel() {
 *   const { deviations, clearDeviations } = useSecurityDeviations();
 *   
 *   return (
 *     <div>
 *       {deviations.map(d => (
 *         <div key={d.id}>
 *           Tool "{d.toolName}" blocked: {d.reason}
 *         </div>
 *       ))}
 *       <button onClick={clearDeviations}>Clear</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useSecurityDeviations() {
  const chatContext = useCopilotChat();
  const { visibleMessages } = chatContext;
  const [deviations, setDeviations] = useState<SecurityDeviationEventPayload[]>([]);
  const processedIds = useRef<Set<string>>(new Set());

  // Debug: Log on every render to see if the hook is being called
  console.log("[useSecurityDeviations] Hook called, visibleMessages count:", visibleMessages?.length ?? "undefined");

  useEffect(() => {
    if (!visibleMessages) {
      console.log("[useSecurityDeviations] visibleMessages is undefined/null");
      return;
    }

    // Debug: Log all message IDs to see what format they're in
    console.log("[useSecurityDeviations] Checking messages:", visibleMessages.map((m) => ({
      id: (m as { id?: string }).id,
      content: (m as { content?: string }).content?.substring(0, 50),
    })));

    for (const message of visibleMessages) {
      const msgId = (message as { id?: string }).id;
      if (!msgId) continue;

      // Check if this is a blocked message we haven't processed yet
      // The middleware emits messages with IDs starting with "blocked-msg-{toolCallId}"
      if (msgId.startsWith("blocked-msg-") && !processedIds.current.has(msgId)) {
        console.log("[useSecurityDeviations] Found blocked message:", msgId);
        processedIds.current.add(msgId);

        const content = (message as { content?: string }).content ?? "";
        
        // Extract tool name from message content
        // Pattern: The tool "TOOL_NAME" is not in the allowed tools list
        const toolNameMatch = content.match(/tool "([^"]+)"/i);
        const toolName = toolNameMatch?.[1] ?? "unknown";

        // Extract the toolCallId from the message ID
        const toolCallId = msgId.replace("blocked-msg-", "");

        // Try to determine reason from content
        let reason: SecurityDeviationEventPayload["reason"] = "NOT_IN_ALLOWLIST";
        if (content.toLowerCase().includes("rejected by")) {
          reason = "IS_TOOL_ALLOWED_REJECTED";
        } else if (content.toLowerCase().includes("mismatch")) {
          reason = "SPEC_MISMATCH_DESCRIPTION";
        }

        const deviation: SecurityDeviationEventPayload = {
          id: `deviation-${toolCallId}`,
          toolName,
          toolCallId,
          reason,
          message: content,
          timestamp: Date.now(),
          threadId: "", // Not available from message parsing
          runId: "", // Not available from message parsing
        };

        setDeviations((prev) => [...prev, deviation]);
      }
    }
  }, [visibleMessages]);

  const clearDeviations = useCallback(() => {
    setDeviations([]);
    processedIds.current.clear();
  }, []);

  return {
    deviations,
    clearDeviations,
  };
}
