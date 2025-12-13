import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";

import { HttpAgent } from "@ag-ui/client";
import { NextRequest } from "next/server";

// Base URL for the Claude Agent SDK server
// This should point to your FastAPI server running Claude Agent SDK integration
const CLAUDE_AGENT_URL = process.env.CLAUDE_AGENT_URL || "http://localhost:8000/chat";

// You can use any service adapter here for multi-agent support. We use
// the empty adapter since we're only using one agent.
const serviceAdapter = new ExperimentalEmptyAdapter();

// Create HttpAgent that connects to Claude Agent SDK server
// This agent implements the AbstractAgent interface required by CopilotKit
const claudeAgent = new HttpAgent({
  url: CLAUDE_AGENT_URL,
  // Optional: Set initial state if needed
  // initialState: {
  //   'language': 'en'
  // },
  // Optional: Set initial messages for context
  // initialMessages: [
  //   {
  //     id: '1',
  //     role: 'user',
  //     content: 'Initial message'
  //   }
  // ]
});

// Create CopilotRuntime with the Claude Agent
const runtime = new CopilotRuntime({
  agents: {
    // Agent ID that will be used in the frontend
    'agentic_chat': claudeAgent
  }
});

// Next.js API route handler for CopilotKit runtime requests
export const POST = async (req: NextRequest) => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter,
    endpoint: "/api/copilotkit",
  });

  return handleRequest(req);
};

