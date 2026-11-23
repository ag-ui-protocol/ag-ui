import { type ActionMessage, ActionMessageSchema } from "@a2ui/web_core/v1_0";
import type { RunAgentInput } from "@ag-ui/client";

import type { A2uiMcpOrigin } from "./protocol";

export const A2UI_ACTION_TOOL = "a2ui_action";

export type A2uiActionMode = "agent" | "mcp";

export interface McpAction {
  userAction: ActionMessage["action"];
  mcp: A2uiMcpOrigin;
}

export function readMcpAction(input: RunAgentInput): McpAction | undefined {
  const props = input.forwardedProps as { a2uiAction?: unknown } | undefined;
  const action = props?.a2uiAction;
  if (!isRecord(action) || !isMcpOrigin(action["mcp"])) {
    return undefined;
  }

  const message = ActionMessageSchema.safeParse({
    version: "1.0",
    action: action["userAction"],
  });
  if (!message.success) {
    return undefined;
  }
  return { userAction: message.data.action, mcp: action["mcp"] };
}

function isMcpOrigin(value: unknown): value is A2uiMcpOrigin {
  return (
    isRecord(value) &&
    typeof value["serverHash"] === "string" &&
    (value["serverId"] === undefined ||
      typeof value["serverId"] === "string") &&
    typeof value["resourceUri"] === "string" &&
    typeof value["presentationId"] === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
