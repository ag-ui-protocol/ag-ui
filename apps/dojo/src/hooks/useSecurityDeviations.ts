"use client";

import React, { useState, useCallback, useRef, useEffect, createContext, useMemo } from "react";
import { useCopilotChat } from "@copilotkit/react-core";

/** Marker in tool results to identify blocked tool calls - must match middleware */
const BLOCKED_TOOL_MARKER = "TOOL_BLOCKED_BY_SECURITY_POLICY";

/**
 * Represents a security deviation (blocked tool call) detected by the middleware.
 */
export interface DeviationLog {
  /** Unique identifier for this deviation */
  id: string;
  /** Timestamp when the deviation was detected */
  timestamp: number;
  /** Name of the tool that was blocked */
  toolName: string;
  /** Reason the tool was blocked */
  reason: string;
  /** Display message for the UI */
  displayMessage?: string;
}

/**
 * Context for manually adding deviations from other components.
 * @internal
 */
interface DeviationContextValue {
  addDeviation: (deviation: DeviationLog) => void;
  processedIds: Set<string>;
}

const DeviationContext = createContext<DeviationContextValue | null>(null);

/**
 * Hook to track security deviations (blocked tool calls) from the SecureToolsMiddleware.
 * 
 * This hook detects blocked tool calls by monitoring tool result messages for the
 * BLOCKED_TOOL_MARKER. When a blocked tool is detected, it's added to the deviations list.
 * 
 * The hook provides:
 * 1. `deviations` - Array of blocked tool call records
 * 2. `clearDeviations` - Function to clear the deviation log
 * 3. `addDeviation` - Manually add a deviation to the log
 * 4. `DeviationProvider` - Wrapper component for context (if manual additions needed)
 * 5. `blockedMessages` - Array of display messages for blocked tools (for inline display)
 * 
 * @example
 * ```tsx
 * function SecureToolsDemo() {
 *   const { deviations, clearDeviations, blockedMessages } = useSecurityDeviations();
 * 
 *   return (
 *     <CopilotKit runtimeUrl="/api/copilotkit" agent="secure_tools">
 *       {deviations.length > 0 && (
 *         <div className="deviation-panel">
 *           <h3>Security Deviations:</h3>
 *           {deviations.map(d => (
 *             <div key={d.id}>
 *               Tool "{d.toolName}" blocked: {d.reason}
 *             </div>
 *           ))}
 *           <button onClick={clearDeviations}>Clear</button>
 *         </div>
 *       )}
 *       <CopilotChat />
 *     </CopilotKit>
 *   );
 * }
 * ```
 */
export function useSecurityDeviations() {
  const [deviations, setDeviations] = useState<DeviationLog[]>([]);
  const [blockedMessages, setBlockedMessages] = useState<Array<{ id: string; message: string }>>([]);
  const processedIdsRef = useRef<Set<string>>(new Set());
  
  // Try to get visibleMessages from CopilotChat context
  // This will be undefined if not inside a CopilotKit provider
  let chatContext: ReturnType<typeof useCopilotChat> | null = null;
  try {
    chatContext = useCopilotChat();
  } catch {
    // Not inside CopilotKit provider, that's fine
  }

  const addDeviation = useCallback((deviation: DeviationLog) => {
    if (processedIdsRef.current.has(deviation.id)) return;
    processedIdsRef.current.add(deviation.id);
    setDeviations((prev) => [...prev, deviation]);
    if (deviation.displayMessage) {
      setBlockedMessages((prev) => [...prev, { id: deviation.id, message: deviation.displayMessage! }]);
    }
  }, []);

  const clearDeviations = useCallback(() => {
    setDeviations([]);
    setBlockedMessages([]);
    processedIdsRef.current.clear();
  }, []);

  // Detect blocked tool calls from messages
  useEffect(() => {
    if (!chatContext?.visibleMessages) return;
    
    const messages = chatContext.visibleMessages;
    
    for (const msg of messages) {
      // Check for result messages that might be blocked tool results
      // The message structure varies, but we look for content containing our marker
      const msgAny = msg as unknown as Record<string, unknown>;
      const id = (msgAny.id as string) ?? "";
      
      // Skip if already processed
      if (processedIdsRef.current.has(id)) continue;
      
      // Check if this is a blocked result (ID pattern: blocked-result-*)
      if (id.startsWith("blocked-result-")) {
        processedIdsRef.current.add(id);
        
        // Try to parse the content to get tool info
        let content = "";
        if (typeof msgAny.content === "string") {
          content = msgAny.content;
        } else if (typeof msgAny.result === "string") {
          content = msgAny.result;
        }
        
        // Check for our marker
        if (content.includes(BLOCKED_TOOL_MARKER)) {
          try {
            const parsed = JSON.parse(content);
            // Extract tool call ID from the message ID (blocked-result-{toolCallId})
            const toolCallId = id.replace("blocked-result-", "");
            
            setDeviations((prev) => [
              ...prev,
              {
                id,
                timestamp: Date.now(),
                toolName: "unknown", // We don't have the tool name in the result
                reason: "NOT_IN_ALLOWLIST",
                displayMessage: parsed.message,
              },
            ]);
          } catch {
            // Couldn't parse, still add as deviation
            setDeviations((prev) => [
              ...prev,
              {
                id,
                timestamp: Date.now(),
                toolName: "unknown",
                reason: "NOT_IN_ALLOWLIST",
              },
            ]);
          }
        }
      }
    }
  }, [chatContext?.visibleMessages]);

  // Memoize context value
  const contextValue = useMemo<DeviationContextValue>(
    () => ({ addDeviation, processedIds: processedIdsRef.current }),
    [addDeviation]
  );

  // Provider component for manual deviation additions
  const DeviationProvider = useCallback(
    ({ children }: { children: React.ReactNode }) =>
      React.createElement(DeviationContext.Provider, { value: contextValue }, children),
    [contextValue]
  );

  return {
    /** Array of detected security deviations (blocked tool calls) */
    deviations,
    /** Array of display messages for blocked tools */
    blockedMessages,
    /** Clear all recorded deviations */
    clearDeviations,
    /** Manually add a deviation to the log */
    addDeviation,
    /** Provider component - wrap your content with this for manual additions */
    DeviationProvider,
  };
}

/**
 * Hook to access deviation context for manual additions.
 * Must be used within a DeviationProvider.
 */
export function useDeviationContext() {
  const ctx = React.useContext(DeviationContext);
  if (!ctx) {
    throw new Error("useDeviationContext must be used within a DeviationProvider");
  }
  return ctx;
}
