import {
  type ActivitySnapshotEvent,
  type BaseEvent,
  EventType,
  type ToolCallResultEvent,
} from "@ag-ui/client";
import type { MCPAppsActivityType } from "../index";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface McpAppsActivityContent {
  result: CallToolResult;
  resourceUri: string;
  serverHash: string;
  serverId?: string;
}

export interface A2uiSource {
  snapshot: ActivitySnapshotEvent;
  content: McpAppsActivityContent;
  resourceUri: string;
}

const MCP_APPS_ACTIVITY_TYPE: typeof MCPAppsActivityType = "mcp-apps";

const MCP_APP_SCHEME = "ui://";

export function readToolCallId(event: BaseEvent): string | undefined {
  if (event.type !== EventType.TOOL_CALL_RESULT) {
    return undefined;
  }
  return (event as ToolCallResultEvent).toolCallId;
}

export function isA2uiCandidate(
  event: BaseEvent,
): event is ActivitySnapshotEvent {
  if (!isMcpAppsSnapshot(event)) {
    return false;
  }
  const resourceUri = resolveResourceUri(event);
  return !resourceUri.startsWith(MCP_APP_SCHEME);
}

export function readA2uiSource(snapshot: ActivitySnapshotEvent): A2uiSource {
  const content = snapshot.content as McpAppsActivityContent;
  const resourceUri = resolveResourceUri(snapshot);
  return { snapshot, content, resourceUri };
}

function isMcpAppsSnapshot(event: BaseEvent): event is ActivitySnapshotEvent {
  return (
    event.type === EventType.ACTIVITY_SNAPSHOT &&
    (event as ActivitySnapshotEvent).activityType === MCP_APPS_ACTIVITY_TYPE
  );
}

function resolveResourceUri(snapshot: ActivitySnapshotEvent): string {
  const content = snapshot.content as McpAppsActivityContent;
  return readResultResourceUri(content.result) ?? content.resourceUri;
}

function readResultResourceUri(result: CallToolResult): string | undefined {
  const ui = result._meta?.["ui"];
  if (typeof ui !== "object" || ui === null || !("resourceUri" in ui)) {
    return undefined;
  }
  return typeof ui.resourceUri === "string" ? ui.resourceUri : undefined;
}
