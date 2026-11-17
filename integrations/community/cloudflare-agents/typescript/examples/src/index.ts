/**
 * Cloudflare Agents Worker for the AG-UI Dojo.
 *
 * Each demo is an Agents SDK agent (see ./agents.ts) and each AG-UI thread is
 * one instance of it. The Agents SDK's own router does the routing:
 * `POST /agents/<demo>/<threadId>` (what `CloudflareAgentsHttpAgent` sends)
 * reaches that thread's Durable Object, which streams the run back over SSE.
 * The same path also accepts the agent's WebSocket. The Dojo uses a plain
 * `HttpAgent`, which posts every thread to `/agents/<demo>`; `toThreadRequest`
 * moves the thread id from the body into the path first.
 */
import { routeAgentRequest } from "agents";
import { toThreadRequest } from "@ag-ui/cloudflare-agents";
import type { Env } from "./agents";

export {
  AgenticChat,
  AgenticChatMultimodal,
  AgenticChatReasoning,
  AgenticGenerativeUi,
  BackendToolRendering,
  HumanInTheLoop,
  HumanInTheLoopApproval,
  PredictiveStateUpdates,
  SharedState,
  ToolBasedGenerativeUi,
} from "./agents";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }
    return (
      (await routeAgentRequest(await toThreadRequest(request), env)) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
