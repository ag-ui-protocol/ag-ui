/**
 * Spring AI is a simple, flexible framework for building agentic generative AI applications that allow large language models to work with your data in any format.
 */

import { HttpAgent } from "@ag-ui/client";

export class SpringAiAgent extends HttpAgent {
  public override get maxVersion(): string {
    return "0.0.39";
  }
}
