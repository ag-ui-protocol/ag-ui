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
    id: "human_in_the_loop",
    name: "Human in the loop",
    description: "Plan a task together and direct the Copilot to take the right steps",
    tags: ["HITL", "Interactivity"],
  }),
  createFeatureConfig({
    id: "agentic_generative_ui",
    name: "Agentic Generative UI",
    description: "Assign a long running task to your Copilot and see how it performs!",
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
    description: "Use collaboration to edit a document in real time with your Copilot",
    tags: ["State", "Streaming", "Tools"],
  }),
];

export default featureConfig;
