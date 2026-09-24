import { agenticChatGraph } from "./agent.ts";
import { aguiTransformer } from "@ag-ui/langgraph/transformer";

// Explicit Platform test lane: the ordinary agent exports the raw graph.
export const graph = agenticChatGraph.withConfig({
  streamTransformers: [aguiTransformer],
});
