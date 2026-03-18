import { FeatureConfig } from "@/types/feature";

// A helper method to creating a config
function createFeatureConfig({
  id,
  name,
  description,
  tags,
}: Pick<FeatureConfig, "id" | "name" | "description" | "tags">): FeatureConfig {
  return {
    id,
    name,
    description,
    path: `/feature/${id}`,
    tags,
  };
}

export const featureConfig: FeatureConfig[] = [
  createFeatureConfig({
    id: "agentic_chat",
    name: "Agentic Chat",
    description: "Chat with your Copilot and call frontend tools",
    tags: ["Chat", "Tools", "Streaming"],
  }),
  createFeatureConfig({
    id: "backend_tool_rendering",
    name: "Backend Tool Rendering",
    description: "Render and stream your backend tools to the frontend.",
    tags: ["Agent State", "Collaborating"],
  }),
  createFeatureConfig({
    id: "human_in_the_loop",
    name: "Human in the loop",
    description:
      "Plan a task together and direct the Copilot to take the right steps",
    tags: ["HITL", "Interactivity"],
  }),
  createFeatureConfig({
    id: "agentic_generative_ui",
    name: "Agentic Generative UI",
    description:
      "Assign a long running task to your Copilot and see how it performs!",
    tags: ["Generative ui (agent)", "Long running task"],
  }),
  createFeatureConfig({
    id: "tool_based_generative_ui",
    name: "Tool Based Generative UI",
    description: "Haiku generator that uses tool based generative UI.",
    tags: ["Generative ui (action)", "Tools"],
  }),
  createFeatureConfig({
    id: "shared_state",
    name: "Shared State between agent and UI",
    description: "A recipe Copilot which reads and updates collaboratively",
    tags: ["Agent State", "Collaborating"],
  }),
  createFeatureConfig({
    id: "predictive_state_updates",
    name: "Predictive State Updates",
    description:
      "Use collaboration to edit a document in real time with your Copilot",
    tags: ["State", "Streaming", "Tools"],
  }),
  createFeatureConfig({
    id: "agentic_chat_reasoning",
    name: "Agentic Chat Reasoning",
    description: "Chat with a reasoning Copilot and call frontend tools",
    tags: ["Chat", "Tools", "Streaming", "Reasoning"],
  }),
  createFeatureConfig({
    id: "subgraphs",
    name: "Subgraphs",
    description:
      "Have your tasks performed by multiple agents, working together",
    tags: ["Chat", "Multi-agent architecture", "Streaming", "Subgraphs"],
  }),
  createFeatureConfig({
    id: "a2a_chat",
    name: "A2A Chat",
    description: "Chat with your Copilot and call frontend tools",
    tags: ["Chat", "Tools", "Streaming"],
  }),
  createFeatureConfig({
    id: "vnext_chat",
    name: "VNext Chat",
    description: "Chat based on CopilotKit vnext",
    tags: ["Chat", "VNext", "Streaming"],
  }),
  createFeatureConfig({
    id: "a2ui_fixed_schema",
    name: "A2UI Fixed Schema",
    description: "Fixed-schema A2UI flight search with data-bound cards (no streaming)",
    tags: ["A2UI", "Generative UI", "Fixed Schema"],
  }),
  createFeatureConfig({
    id: "a2ui_fixed_schema_streaming",
    name: "A2UI Fixed Schema (Streaming)",
    description: "Fixed-schema A2UI flight search with streaming progressive rendering",
    tags: ["A2UI", "Generative UI", "Fixed Schema", "Streaming"],
  }),
  createFeatureConfig({
    id: "a2ui_dynamic_schema",
    name: "A2UI Dynamic Schema",
    description: "Dynamic LLM-generated A2UI surfaces from conversation context",
    tags: ["A2UI", "Generative UI", "Dynamic Schema", "Streaming"],
  }),
  createFeatureConfig({
    id: "a2ui_advanced",
    name: "A2UI Advanced",
    description: "Dynamic A2UI with custom progress renderer and frontend action handlers",
    tags: ["A2UI", "Advanced", "Progress", "Action Handlers"],
  }),
];

export default featureConfig;
