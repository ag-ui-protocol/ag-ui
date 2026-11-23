import {
  type AbstractAgent,
  EventType,
  randomUUID,
  type RunAgentInput,
  type RunFinishedEvent,
} from "@ag-ui/client";
import type { ProxiedMCPRequest } from "../index";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { filter, lastValueFrom } from "rxjs";

import { A2uiMcpError } from "./a2ui-messages";
import type { McpAppsActivityContent } from "./mcp-apps-events";

export type McpServerRef = Pick<
  McpAppsActivityContent,
  "serverHash" | "serverId"
>;

export async function readMcpResource(
  server: McpServerRef,
  uri: string,
  input: RunAgentInput,
  next: AbstractAgent,
): Promise<ReadResourceResult> {
  const request: ProxiedMCPRequest = {
    serverHash: server.serverHash,
    serverId: server.serverId,
    method: "resources/read",
    params: { uri },
  };
  const result = await sendMcpRequest(request, input, next);

  if (!result || "error" in result) {
    throw new A2uiMcpError(`The A2UI resource ${uri} could not be read.`);
  }
  return result as ReadResourceResult;
}

export async function callMcpTool(
  server: McpServerRef,
  name: string,
  args: Record<string, unknown>,
  input: RunAgentInput,
  next: AbstractAgent,
): Promise<CallToolResult> {
  const request: ProxiedMCPRequest = {
    serverHash: server.serverHash,
    serverId: server.serverId,
    method: "tools/call",
    params: { name, arguments: args },
  };
  const result = await sendMcpRequest(request, input, next);

  if (!result || "error" in result || result["isError"] === true) {
    throw new A2uiMcpError(`The MCP tool ${name} failed.`);
  }
  return result as CallToolResult;
}

async function sendMcpRequest(
  request: ProxiedMCPRequest,
  input: RunAgentInput,
  next: AbstractAgent,
): Promise<Record<string, unknown> | undefined> {
  const proxiedInput: RunAgentInput = {
    ...input,
    runId: randomUUID(),
    messages: [],
    tools: [],
    context: [],
    forwardedProps: { __proxiedMCPRequest: request },
  };

  const finished$ = next
    .run(proxiedInput)
    .pipe(filter((event) => event.type === EventType.RUN_FINISHED));
  const finished = (await lastValueFrom(finished$)) as RunFinishedEvent;
  return finished.result as Record<string, unknown> | undefined;
}
