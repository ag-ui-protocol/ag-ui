/**
 * One agent per AG-UI Dojo feature, each backed by OpenAI Agents API sessions.
 *
 * Every agent is defined inline (model, instructions, tools), so there is
 * nothing to provision: a session is created on a thread's first run.
 */

import type { AbstractAgent } from "@ag-ui/client";
import OpenAI from "openai";
import {
  OpenAIAgentsAgent,
  type BackendTool,
  type OpenAIAgentsAgentConfig,
} from "../src";
import { a2uiFixedSchemaTools } from "./a2ui";
import { PipelineAgent } from "./pipeline";
import { subgraphTools } from "./subgraphs";

export const MODEL = process.env.OPENAI_AGENTS_MODEL ?? "gpt-6-astra";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// -----------------------------------------------------------------------------
// Backend tools

const getWeather: BackendTool<{ location: string }> = {
  name: "get_weather",
  description: "Get the current weather for a location.",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "City name, e.g. Paris" },
    },
    required: ["location"],
  },
  handler: ({ location }) => ({
    location,
    temperature: 21,
    feelsLike: 19,
    conditions: "Sunny",
    humidity: 48,
    windSpeed: 12,
  }),
};

type Step = { description: string; status: "pending" | "completed" };

const generateTaskSteps: BackendTool<{ steps: Step[] }> = {
  name: "generate_task_steps_generative_ui",
  description:
    'Shows a plan in the app and carries it out step by step. Each step has a short imperative `description` and `status: "pending"`.',
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            status: { type: "string", enum: ["pending"] },
          },
          required: ["description", "status"],
        },
      },
    },
    required: ["steps"],
  },
  handler: async ({ steps }, context) => {
    const plan: Step[] = steps.map((step) => ({
      description: String(step.description),
      status: "pending",
    }));
    const base = context.state as Record<string, unknown>;
    context.setState({ ...base, steps: plan });
    for (let index = 0; index < plan.length; index++) {
      await sleep(600);
      plan[index] = { ...plan[index], status: "completed" };
      context.setState({ ...base, steps: plan.map((step) => ({ ...step })) });
    }
    return {
      status: "completed",
      message: `All ${plan.length} steps are done.`,
    };
  },
};

const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    skill_level: {
      type: "string",
      enum: ["Beginner", "Intermediate", "Advanced"],
    },
    cooking_time: {
      type: "string",
      enum: ["5 min", "15 min", "30 min", "45 min", "60+ min"],
    },
    special_preferences: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "High Protein",
          "Low Carb",
          "Spicy",
          "Budget-Friendly",
          "One-Pot Meal",
          "Vegetarian",
          "Vegan",
        ],
      },
    },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          icon: { type: "string", description: "One emoji, e.g. 🥕" },
          name: { type: "string" },
          amount: { type: "string" },
        },
        required: ["icon", "name", "amount"],
      },
    },
    instructions: { type: "array", items: { type: "string" } },
  },
  required: [
    "title",
    "skill_level",
    "cooking_time",
    "special_preferences",
    "ingredients",
    "instructions",
  ],
};

const generateRecipe: BackendTool<{ recipe: Record<string, unknown> }> = {
  name: "generate_recipe",
  description:
    "Creates or replaces the recipe shown in the app. ALWAYS pass the complete recipe with every field, not just the changes.",
  parameters: {
    type: "object",
    properties: { recipe: RECIPE_SCHEMA },
    required: ["recipe"],
  },
  handler: ({ recipe }, context) => {
    context.setState({ ...(context.state as Record<string, unknown>), recipe });
    return "Recipe updated successfully.";
  },
};

const scheduleMeeting: BackendTool<{ topic: string; attendee?: string }> = {
  name: "schedule_meeting",
  description: "Schedule a meeting. The user picks the time in the app.",
  parameters: {
    type: "object",
    properties: {
      topic: { type: "string", description: "What the meeting is about" },
      attendee: { type: "string", description: "Who the meeting is with" },
    },
    required: ["topic"],
  },
  handler: ({ topic, attendee }, context) => {
    // First call: pause and ask. The session stays parked on this call until
    // the user answers, and the handler runs again with `context.resume` set.
    if (!context.resume) {
      context.interrupt({
        reason: "schedule_meeting",
        message: `Pick a time for "${topic}"`,
        payload: { topic, attendee },
      });
    }
    const answer = context.resume!.payload as
      | { chosen_label?: string; cancelled?: boolean }
      | undefined;
    if (context.resume!.status !== "resolved" || !answer || answer.cancelled) {
      return `User cancelled. Meeting NOT scheduled: ${topic}`;
    }
    return `Meeting scheduled for ${answer.chosen_label}: ${topic}`;
  },
};

const recordExpense: BackendTool<{ amount: number; description: string }> = {
  name: "record_expense",
  description: "Record an expense in the ledger.",
  parameters: {
    type: "object",
    properties: {
      amount: { type: "number", description: "Amount in USD" },
      description: { type: "string", description: "Short description" },
    },
    required: ["amount", "description"],
  },
  requiresApproval: true,
  approvalMessage: ({ amount, description }) =>
    `Record $${amount} for "${description}"?`,
  handler: ({ amount, description }) => ({
    expenseId: `EXP-${Math.round(amount * 100)}`,
    amount,
    description,
    status: "recorded",
  }),
};

// -----------------------------------------------------------------------------
// Instructions

const CHAT = `You are a helpful, concise assistant. Use the tools the app gives you when they fit the request.
When asked to change the background, call change_background with a CSS background value.`;

const INSTRUCTIONS = {
  agentic_chat: CHAT,
  backend_tool_rendering:
    "You are a weather assistant. When the user asks about the weather, call get_weather, then summarize the result in one sentence.",
  human_in_the_loop: `You plan tasks with the user.
When the user asks you to do or plan something, IMMEDIATELY call generate_task_steps with about 10 short imperative steps, each with status "enabled". Do not list the steps as text.
After the tool returns, confirm in one short sentence which steps the user kept. If the user rejected the plan, ask what to change.`,
  tool_based_generative_ui: `You write haiku. When asked for one, call generate_haiku with three lines in Japanese, their three English translations, an image_name from the tool's allowed list, and a CSS gradient. After the tool returns, reply with one short sentence; do not repeat the haiku.`,
  agentic_generative_ui: `You help the user get things done. When they ask for a plan or task, call generate_task_steps_generative_ui exactly once with 4-6 short gerund steps (e.g. "Mixing the batter"), each with status "pending". Make the plan even for unrealistic tasks. Afterwards do not repeat the steps; say in one short sentence that they are done, with an emoji. Answer anything else directly.`,
  shared_state: `You are a recipe assistant collaborating with the user on the recipe shown in the app.
The current recipe arrives in <application_state> with each message; the user may have edited it.
Whenever the user asks for a recipe or a change, call generate_recipe ONCE with the COMPLETE updated recipe (every field). Then confirm the change in one or two sentences.`,
  predictive_state_updates: `You are a helpful assistant for writing documents.
The current document arrives in <application_state> (key "document").
To write or edit the document, you MUST use the write_document tool. You MUST pass the full updated document, even when changing only a few words. When editing, keep changes minimal.
Format the document with markdown, but never use italic or strike-through formatting; those are reserved for showing the user a diff. Keep stories SHORT.
After calling the tool, do NOT repeat the document. Briefly summarize what you changed, 2 sentences max.`,
  interrupt: `You schedule meetings. When the user wants a meeting or call, you MUST call schedule_meeting with a short topic and the attendee if known. Never ask the user for a time yourself; the tool lets them pick one. Never claim a meeting is scheduled unless the tool result says so. Confirm the outcome in one sentence.`,
  tool_approval: `You record expenses. When the user mentions an expense, call record_expense with the amount in USD and a short description. Do not ask for confirmation yourself; the app asks the user. If the tool result has an expenseId, confirm it in one sentence; if the call was rejected, say the expense was not recorded.`,
  agentic_chat_reasoning: `You are a thoughtful assistant. Think the problem through, then answer clearly and concisely.
When asked to change the background, call change_background with a CSS background value.`,
  agentic_chat_citations: `You are a research assistant. Always search the web before answering. Answer in two or three sentences and cite every source inline as a markdown link [title](url).`,
  subgraphs: `You are a travel planning supervisor. Every trip starts in Amsterdam.
To plan a trip, delegate to your specialists one at a time, in this order: flights_agent, then hotels_agent, then experiences_agent. Call each exactly once, and wait for its result before calling the next.
Never ask the user to choose flights or hotels yourself; the specialists ask them. When all three are done, summarize the itinerary in a few sentences.`,
  a2ui: `You are a helpful assistant that creates rich visual UI on the fly.
When the user asks for visual content (product comparisons, dashboards, team rosters, lists, cards, ...), use the A2UI rendering tool the app provides to create the surface.
IMPORTANT: After calling the tool, do NOT repeat the data in your text response. The tool renders UI automatically. Just confirm briefly what was rendered. If rendering fails, fix the components and try again.`,
  a2ui_fixed_schema: `You are a travel assistant that can search for flights and hotels.
When the user asks about flights, call search_flights; for hotels, call search_hotels. Generate 3-5 realistic results.
Flights need: id, airline, airlineLogo (Google favicon API: https://www.google.com/s2/favicons?domain={airline_domain}&sz=128), flightNumber, origin, destination, date (short, e.g. "Tue, Mar 18", near future), departureTime, arrivalTime, duration (e.g. "4h 25m"), status ("On Time" or "Delayed") and price (e.g. "$289").
Hotels need: id, name, location, rating (0-5) and price (per night, e.g. "$350").
IMPORTANT: After calling a tool, do NOT repeat the results as text. The app renders them as cards. Just say something brief like "Here are your options."`,
};

// -----------------------------------------------------------------------------
// Agents

export function buildAgents(client?: OpenAI): Record<string, AbstractAgent> {
  const shared = client ? { client } : {};
  const agent = (
    instructions: string,
    config: Partial<OpenAIAgentsAgentConfig> = {},
    agentConfig: OpenAIAgentsAgentConfig["agent"] = {},
  ) =>
    new OpenAIAgentsAgent({
      ...shared,
      agent: {
        model: MODEL,
        instructions,
        reasoning: { effort: "low" },
        ...agentConfig,
      },
      ...config,
    });

  const chat = () =>
    agent(INSTRUCTIONS.agentic_chat, { backendTools: [getWeather] });
  const a2uiDynamic = () => agent(INSTRUCTIONS.a2ui);

  return {
    agentic_chat: chat(),
    agentic_chat_multimodal: chat(),
    agentic_chat_reasoning: agent(
      INSTRUCTIONS.agentic_chat_reasoning,
      {},
      { reasoning: { effort: "high", summary: "detailed" } },
    ),
    agentic_chat_citations: agent(
      INSTRUCTIONS.agentic_chat_citations,
      { extractLinkCitations: true },
      { tools: [{ type: "web_search" }] },
    ),
    backend_tool_rendering: agent(INSTRUCTIONS.backend_tool_rendering, {
      backendTools: [getWeather],
    }),
    human_in_the_loop: agent(INSTRUCTIONS.human_in_the_loop),
    tool_based_generative_ui: agent(INSTRUCTIONS.tool_based_generative_ui),
    agentic_generative_ui: agent(INSTRUCTIONS.agentic_generative_ui, {
      backendTools: [generateTaskSteps],
    }),
    shared_state: agent(INSTRUCTIONS.shared_state, {
      backendTools: [generateRecipe],
    }),
    predictive_state_updates: agent(INSTRUCTIONS.predictive_state_updates, {
      predictState: [
        {
          stateKey: "document",
          tool: "write_document",
          toolArgument: "document",
        },
      ],
    }),
    interrupt: agent(INSTRUCTIONS.interrupt, {
      backendTools: [scheduleMeeting],
    }),
    tool_approval: agent(INSTRUCTIONS.tool_approval, {
      backendTools: [recordExpense],
    }),
    subgraphs: agent(INSTRUCTIONS.subgraphs, { backendTools: subgraphTools }),
    multi_agent: new PipelineAgent({ ...shared, model: MODEL }),
    // The runtime's render_ui tool / the markdown instructions arrive as
    // frontend tools and context, so the plain chat agent serves both.
    generative_ui_markdown: chat(),
    generative_ui_tool: chat(),
    a2ui_fixed_schema: agent(INSTRUCTIONS.a2ui_fixed_schema, {
      backendTools: a2uiFixedSchemaTools,
    }),
    // The Dojo applies A2UIMiddleware to these, which injects render_a2ui as a
    // frontend tool and answers it once the surface is painted.
    a2ui_dynamic_schema: a2uiDynamic(),
    a2ui_advanced: a2uiDynamic(),
    a2ui_recovery: a2uiDynamic(),
    // Every run fails: the model does not exist, and the Agents API rejects
    // the session. The adapter reports it as RUN_ERROR.
    error_flow: new OpenAIAgentsAgent({
      ...shared,
      agent: { model: "gpt-model-that-does-not-exist" },
    }),
  };
}
