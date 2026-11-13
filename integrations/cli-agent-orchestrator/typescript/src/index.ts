/**
 * AG-UI integration for CLI Agent Orchestrator (CAO).
 *
 * CAO (github.com/awslabs/cli-agent-orchestrator) runs coding-agent CLIs as
 * processes in tmux and serves AG-UI at `POST /agui/v1/run`. When a CLI is
 * waiting at a permission prompt, the run finishes with an interrupt outcome,
 * and a later run answers it through `resume[]`.
 *
 * CAO's endpoint already speaks standard AG-UI, so this client is `HttpAgent`
 * with no extra logic.
 *
 * @see https://github.com/awslabs/cli-agent-orchestrator/blob/main/docs/agui.md
 */
import { HttpAgent } from "@ag-ui/client";

/**
 * AG-UI client for a CLI Agent Orchestrator `POST /agui/v1/run` endpoint. It
 * takes the standard `HttpAgentConfig` and no CAO-specific options.
 *
 * @example
 * ```ts
 * import { CliAgentOrchestratorAgent } from "@ag-ui/cli-agent-orchestrator";
 *
 * const agent = new CliAgentOrchestratorAgent({
 *   url: "http://127.0.0.1:9889/agui/v1/run",
 * });
 * ```
 */
export class CliAgentOrchestratorAgent extends HttpAgent {}
