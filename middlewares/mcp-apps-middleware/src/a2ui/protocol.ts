import type {
  ActionPayload,
  AgentToRendererMessage,
} from "@a2ui/web_core/v1_0";

export const A2UI_MIME_TYPE = "application/a2ui+json";

export const A2UI_ACTIVITY_TYPE = "a2ui-surface-v1";

export interface A2uiMcpOrigin {
  serverHash: string;
  serverId?: string;
  resourceUri: string;
  presentationId: string;
}

export interface A2uiActivityContent {
  a2ui_operations: AgentToRendererMessage[];
  error?: string;
  mcp?: A2uiMcpOrigin;
}

export interface A2uiAction {
  userAction: ActionPayload;
  mcp?: A2uiMcpOrigin;
}
