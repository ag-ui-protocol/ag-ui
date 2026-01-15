"use client";

import React, { useState, useCallback, useRef, useEffect, createContext, useContext, useMemo } from "react";
import { AssistantMessage, type AssistantMessageProps } from "@copilotkit/react-ui";

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
  /** Optional full message content */
  message?: string;
}

/**
 * Context for passing deviation tracking to the SecurityAwareAssistantMessage component.
 * @internal
 */
interface DeviationContextValue {
  addDeviation: (deviation: DeviationLog) => void;
  processedIds: React.MutableRefObject<Set<string>>;
}

const DeviationContext = createContext<DeviationContextValue | null>(null);

/**
 * Custom AssistantMessage component that detects blocked tool messages
 * and reports them to the deviation tracking system.
 * 
 * This component wraps the default CopilotKit AssistantMessage component
 * to preserve all default styling and functionality while adding
 * deviation detection.
 * 
 * @example
 * ```tsx
 * const { SecurityAwareAssistantMessage } = useSecurityDeviations();
 * 
 * <CopilotChat
 *   AssistantMessage={SecurityAwareAssistantMessage}
 *   // ... other props
 * />
 * ```
 */
function SecurityAwareAssistantMessageInner(props: AssistantMessageProps) {
  const ctx = useContext(DeviationContext);
  const { message } = props;

  useEffect(() => {
    if (!ctx || !message) return;

    const msgId = message.id;
    const content = message.content;

    // Detect blocked messages by their ID pattern
    // The middleware emits messages with IDs starting with "blocked-msg-{toolCallId}"
    if (msgId?.startsWith("blocked-msg-") && !ctx.processedIds.current.has(msgId)) {
      ctx.processedIds.current.add(msgId);

      // Extract tool name from content (pattern: tool "TOOL_NAME")
      const toolNameMatch = content?.match(/tool "([^"]+)"/i);
      const toolName = toolNameMatch?.[1] ?? "unknown";

      // Extract reason from content if present (pattern: Reason: REASON)
      const reasonMatch = content?.match(/Reason:\s*([A-Z_]+)/i);
      const reason = reasonMatch?.[1] ?? "NOT_IN_ALLOWLIST";

      ctx.addDeviation({
        id: msgId,
        timestamp: Date.now(),
        toolName,
        reason,
        message: content,
      });
    }
  }, [ctx, message]);

  // Use the default CopilotKit AssistantMessage component for proper styling
  return React.createElement(AssistantMessage, props);
}

/**
 * Hook to track security deviations (blocked tool calls) from the SecureToolsMiddleware.
 * 
 * This hook provides:
 * 1. `deviations` - Array of blocked tool call records
 * 2. `clearDeviations` - Function to clear the deviation log
 * 3. `DeviationProvider` - Wrapper component that enables deviation tracking
 * 4. `SecurityAwareAssistantMessage` - Custom message component for CopilotChat
 * 
 * The middleware emits blocked tool messages with IDs starting with "blocked-msg-".
 * The `SecurityAwareAssistantMessage` component detects these and adds them to the
 * deviation log automatically.
 * 
 * @example
 * ```tsx
 * function SecureToolsDemo() {
 *   const { 
 *     deviations, 
 *     clearDeviations,
 *     DeviationProvider, 
 *     SecurityAwareAssistantMessage 
 *   } = useSecurityDeviations();
 * 
 *   return (
 *     <CopilotKit runtimeUrl="/api/copilotkit" agent="secure_tools">
 *       <DeviationProvider>
 *         {deviations.length > 0 && (
 *           <div className="deviation-panel">
 *             <h3>Security Deviations:</h3>
 *             {deviations.map(d => (
 *               <div key={d.id}>
 *                 Tool "{d.toolName}" blocked: {d.reason}
 *               </div>
 *             ))}
 *             <button onClick={clearDeviations}>Clear</button>
 *           </div>
 *         )}
 *         <CopilotChat AssistantMessage={SecurityAwareAssistantMessage} />
 *       </DeviationProvider>
 *     </CopilotKit>
 *   );
 * }
 * ```
 */
export function useSecurityDeviations() {
  const [deviations, setDeviations] = useState<DeviationLog[]>([]);
  const processedIds = useRef<Set<string>>(new Set());

  const addDeviation = useCallback((deviation: DeviationLog) => {
    setDeviations((prev) => [...prev, deviation]);
  }, []);

  const clearDeviations = useCallback(() => {
    setDeviations([]);
    processedIds.current.clear();
  }, []);

  // Memoize the context value to prevent unnecessary re-renders
  const contextValue = useMemo<DeviationContextValue>(
    () => ({ addDeviation, processedIds }),
    [addDeviation]
  );

  // Provider component that wraps content and enables deviation tracking
  const DeviationProvider = useCallback(
    ({ children }: { children: React.ReactNode }) =>
      React.createElement(DeviationContext.Provider, { value: contextValue }, children),
    [contextValue]
  );

  // Memoize the AssistantMessage component reference
  const SecurityAwareAssistantMessage = useMemo(
    () => SecurityAwareAssistantMessageInner,
    []
  );

  return {
    /** Array of detected security deviations (blocked tool calls) */
    deviations,
    /** Clear all recorded deviations */
    clearDeviations,
    /** Manually add a deviation to the log */
    addDeviation,
    /** Provider component - wrap your CopilotChat with this */
    DeviationProvider,
    /** Custom AssistantMessage component - pass to CopilotChat's AssistantMessage prop */
    SecurityAwareAssistantMessage,
  };
}
