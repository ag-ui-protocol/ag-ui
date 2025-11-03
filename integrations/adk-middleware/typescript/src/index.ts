import { HttpAgent } from "@ag-ui/client";

export class ADKAgent extends HttpAgent {
  public override get maxVersion(): string {
    return "0.0.39";
  }
}
