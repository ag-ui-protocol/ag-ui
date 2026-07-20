import { HttpAgent } from "@ag-ui/client";

/**
 * A thin AG-UI client for CLI Agent Orchestrator (CAO) backed agents.
 *
 * This class extends HttpAgent without adding extra logic because CAO
 * already exposes a fully AG-UI-compliant streaming endpoint. The class
 * provides a named entry point so consumers can instantiate an agent
 * that is semantically tied to a CAO backend.
 */
export class CliAgentOrchestratorAgent extends HttpAgent {}
