import { HttpAgent } from "@ag-ui/client";

export class ClaudeAgentSDKAgent extends HttpAgent {
  public override get maxVersion(): string {
    return "0.1.0";
  }
}

