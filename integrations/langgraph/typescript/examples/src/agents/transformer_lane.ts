import { aguiTransformer } from "@ag-ui/langgraph/transformer";
import { agenticChatGraph as agentic_chatSource } from "./agentic_chat/agent.js";
import { agenticGenerativeUiGraph as agentic_generative_uiSource } from "./agentic_generative_ui/agent.js";
import { humanInTheLoopGraph as human_in_the_loopSource } from "./human_in_the_loop/agent.js";
import { predictiveStateUpdatesGraph as predictive_state_updatesSource } from "./predictive_state_updates/agent.js";
import { sharedStateGraph as shared_stateSource } from "./shared_state/agent.js";
import { toolBasedGenerativeUiGraph as tool_based_generative_uiSource } from "./tool_based_generative_ui/agent.js";
import { subGraphsAgentGraph as subgraphsSource } from "./subgraphs/agent.js";
import { agenticChatMultimodalGraph as agentic_chat_multimodalSource } from "./agentic_chat_multimodal/agent.js";
import { agenticChatReasoningGraph as agentic_chat_reasoningSource } from "./agentic_chat_reasoning/agent.js";
import { a2uiDynamicSchemaGraph as a2ui_dynamic_schemaSource } from "./a2ui_dynamic_schema/agent.js";
import { a2uiFixedSchemaGraph as a2ui_fixed_schemaSource } from "./a2ui_fixed_schema/agent.js";
import { a2uiRecoveryGraph as a2ui_recoveryAgent } from "./a2ui_recovery/agent.js";

// createAgent returns a Runnable wrapper. Configure the actual compiled graph
// so Platform can attach both its transformer and its managed checkpointer.
const a2ui_recoverySource = a2ui_recoveryAgent.graph;

// withConfig appends transformers. Preserve configured factories (including
// prediction hints) and add AG-UI only when the source graph has none.
export const agentic_chat = agentic_chatSource.withConfig({
  streamTransformers: agentic_chatSource.streamTransformers.length
    ? []
    : [aguiTransformer],
});
export const agentic_generative_ui = agentic_generative_uiSource.withConfig({
  streamTransformers: agentic_generative_uiSource.streamTransformers.length
    ? []
    : [aguiTransformer],
});
export const human_in_the_loop = human_in_the_loopSource.withConfig({
  streamTransformers: human_in_the_loopSource.streamTransformers.length
    ? []
    : [aguiTransformer],
});
export const predictive_state_updates =
  predictive_state_updatesSource.withConfig({
    streamTransformers: predictive_state_updatesSource.streamTransformers.length
      ? []
      : [aguiTransformer],
  });
export const shared_state = shared_stateSource.withConfig({
  streamTransformers: shared_stateSource.streamTransformers.length
    ? []
    : [aguiTransformer],
});
export const tool_based_generative_ui =
  tool_based_generative_uiSource.withConfig({
    streamTransformers: tool_based_generative_uiSource.streamTransformers.length
      ? []
      : [aguiTransformer],
  });
export const subgraphs = subgraphsSource.withConfig({
  streamTransformers: subgraphsSource.streamTransformers.length
    ? []
    : [aguiTransformer],
});
export const agentic_chat_multimodal = agentic_chat_multimodalSource.withConfig(
  {
    streamTransformers: agentic_chat_multimodalSource.streamTransformers.length
      ? []
      : [aguiTransformer],
  },
);
export const agentic_chat_reasoning = agentic_chat_reasoningSource.withConfig({
  streamTransformers: agentic_chat_reasoningSource.streamTransformers.length
    ? []
    : [aguiTransformer],
});
export const a2ui_dynamic_schema = a2ui_dynamic_schemaSource.withConfig({
  streamTransformers: a2ui_dynamic_schemaSource.streamTransformers.length
    ? []
    : [aguiTransformer],
});
export const a2ui_fixed_schema = a2ui_fixed_schemaSource.withConfig({
  streamTransformers: a2ui_fixed_schemaSource.streamTransformers.length
    ? []
    : [aguiTransformer],
});
export const a2ui_recovery = a2ui_recoverySource.withConfig({
  streamTransformers: a2ui_recoverySource.streamTransformers.length
    ? []
    : [aguiTransformer],
});
