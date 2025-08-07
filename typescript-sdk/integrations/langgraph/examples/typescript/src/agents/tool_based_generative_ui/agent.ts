/**
 * An example demonstrating tool-based generative UI using LangGraph.
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { Command, Annotation, MessagesAnnotation, StateGraph, END, START } from "@langchain/langgraph";

// List of available images (modify path if needed)
const IMAGE_LIST = [
  "Osaka_Castle_Turret_Stone_Wall_Pine_Trees_Daytime.jpg",
  "Tokyo_Skyline_Night_Tokyo_Tower_Mount_Fuji_View.jpg",
  "Itsukushima_Shrine_Miyajima_Floating_Torii_Gate_Sunset_Long_Exposure.jpg",
  "Takachiho_Gorge_Waterfall_River_Lush_Greenery_Japan.jpg",
  "Bonsai_Tree_Potted_Japanese_Art_Green_Foliage.jpeg",
  "Shirakawa-go_Gassho-zukuri_Thatched_Roof_Village_Aerial_View.jpg",
  "Ginkaku-ji_Silver_Pavilion_Kyoto_Japanese_Garden_Pond_Reflection.jpg",
  "Senso-ji_Temple_Asakusa_Cherry_Blossoms_Kimono_Umbrella.jpg",
  "Cherry_Blossoms_Sakura_Night_View_City_Lights_Japan.jpg",
  "Mount_Fuji_Lake_Reflection_Cherry_Blossoms_Sakura_Spring.jpg"
];

// This tool generates a haiku on the server.
// The tool call will be streamed to the frontend as it is being generated.
const GENERATE_HAIKU_TOOL = {
  type: "function",
  function: {
    name: "generate_haiku",
    description: "Generate a haiku in Japanese and its English translation. Also select exactly 3 relevant images from the provided list based on the haiku's theme.",
    parameters: {
      type: "object",
      properties: {
        japanese: {
          type: "array",
          items: {
            type: "string"
          },
          description: "An array of three lines of the haiku in Japanese"
        },
        english: {
          type: "array",
          items: {
            type: "string"
          },
          description: "An array of three lines of the haiku in English"
        },
        image_names: {
          type: "array",
          items: {
            type: "string"
          },
          description: "An array of EXACTLY THREE image filenames from the provided list that are most relevant to the haiku."
        }
      },
      required: ["japanese", "english", "image_names"]
    }
  }
};

export const AgentStateAnnotation = Annotation.Root({
  tools: Annotation<any[]>(),
  ...MessagesAnnotation.spec,
});
export type AgentState = typeof AgentStateAnnotation.State;

async function chatNode(state: AgentState, config?: RunnableConfig): Promise<Command> {
  /**
   * The main function handling chat and tool calls.
   */
  // Prepare the image list string for the prompt
  const imageListStr = IMAGE_LIST.map(img => `- ${img}`).join("\n");

  const systemPrompt = `
        You assist the user in generating a haiku.
        When generating a haiku using the 'generate_haiku' tool, you MUST also select exactly 3 image filenames from the following list that are most relevant to the haiku's content or theme. Return the filenames in the 'image_names' parameter.
        
        Available images:
        ${imageListStr}
        
        Don't provide the relevant image names in your final response to the user.
    `;

  // Define the model
  const model = new ChatOpenAI({ model: "gpt-4o" });
  
  // Define config for the model
  if (!config) {
    config = { recursionLimit: 25 };
  }

  // Bind the tools to the model
  const modelWithTools = model.bindTools(
    [GENERATE_HAIKU_TOOL],
    {
      // Disable parallel tool calls to avoid race conditions
      parallel_tool_calls: false,
    }
  );

  // Run the model to generate a response
  const response = await modelWithTools.invoke([
    new SystemMessage({ content: systemPrompt }),
    ...state.messages,
  ], config);

  // Return Command to end with updated messages
  return new Command({
    goto: END,
    update: {
      messages: [...state.messages, response]
    }
  });
}

// Define the graph
const workflow = new StateGraph<AgentState>(AgentStateAnnotation);

// Add nodes
workflow.addNode("chat_node", chatNode);

// Add edges
workflow.setEntryPoint("chat_node");
workflow.addEdge(START, "chat_node");
workflow.addEdge("chat_node", END);

// Compile the graph
export const toolBasedGenerativeUiGraph = workflow.compile();