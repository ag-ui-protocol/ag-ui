/**
 * OpenClaw integration for the AG-UI protocol.
 *
 * Connects to an OpenClaw gateway that exposes the AG-UI protocol over HTTP/SSE
 * via the `clawg-ui` channel plugin (e.g. the operator route
 * `/v1/clawg-ui/operator`). OpenClaw speaks the current AG-UI protocol, so no
 * version capping is required — the standard `HttpAgent` transport handles the
 * `RunAgentInput` request and the streamed event response as-is.
 *
 * @see https://github.com/openclaw/openclaw
 */

import { HttpAgent } from "@ag-ui/client";

export class OpenClawAgent extends HttpAgent {}
