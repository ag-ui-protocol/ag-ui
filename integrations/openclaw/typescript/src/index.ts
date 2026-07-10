/**
 * OpenClaw integration for the AG-UI protocol.
 *
 * Connects an AG-UI / CopilotKit frontend to an OpenClaw gateway that speaks the
 * AG-UI protocol over HTTP/SSE via the `clawg-ui` channel plugin (e.g. the
 * operator route `/v1/clawg-ui/operator`). OpenClaw speaks the current AG-UI
 * protocol, so the standard `HttpAgent` transport handles the request/response
 * as-is — no version capping required.
 *
 * @see https://github.com/openclaw/openclaw
 */

import { HttpAgent, type HttpAgentConfig } from "@ag-ui/client";

/**
 * Config for {@link OpenClawAgent}. Extends the base `HttpAgent` config with a
 * first-class `gatewayToken` — the OpenClaw gateway operator token — so callers
 * pass the secret directly instead of hand-assembling an `Authorization` header.
 */
export interface OpenClawAgentConfig extends HttpAgentConfig {
  /**
   * OpenClaw gateway operator token. When set, the agent sends
   * `Authorization: Bearer <gatewayToken>` on every request to the clawg-ui
   * operator route. Omit (or leave empty) to send no auth header.
   */
  gatewayToken?: string;
}

/**
 * `HttpAgent` for an OpenClaw gateway's `clawg-ui` operator route. Its one
 * addition over `HttpAgent` is the `gatewayToken` convenience: pass the operator
 * token and it becomes the `Authorization: Bearer` header (authoritative over any
 * `Authorization` supplied in `headers`).
 */
export class OpenClawAgent extends HttpAgent {
  constructor({ gatewayToken, headers, ...rest }: OpenClawAgentConfig) {
    super({
      ...rest,
      headers: {
        ...headers,
        ...(gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {}),
      },
    });
  }
}
