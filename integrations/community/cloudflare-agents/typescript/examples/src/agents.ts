/**
 * The Dojo's Cloudflare agents: one Agents SDK `Agent` (a Durable Object) per
 * demo, each made AG-UI-capable by `withAGUI`. A thread is one instance of
 * its demo's agent, and the agent's `state` is the thread's shared state.
 *
 * Every system prompt names its demo ("Cloudflare Agents Dojo <role>"), which
 * is how the Dojo's aimock fixtures tell these agents' requests apart.
 */
import { Agent } from "agents";
import { withAGUI, type AGUIRun } from "@ag-ui/cloudflare-agents";
import { createOpenAI } from "@ai-sdk/openai";
import {
  parsePartialJson,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type ToolSet,
} from "ai";
import { z } from "zod";

export interface Env {
  OPENAI_BASE_URL: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL: string;
  OPENAI_REASONING_MODEL: string;
}

type DojoState = Record<string, unknown>;
type Run = AGUIRun<DojoState>;

/** What every demo shares: the model, the client's tools, the run loop. */
abstract class DojoAgent extends withAGUI(Agent<Env, DojoState>) {
  initialState: DojoState = {};

  /** The demo's own instructions. */
  protected abstract readonly prompt: string;

  /** The demo's server tools. */
  protected tools(_run: Run): ToolSet {
    return {};
  }

  protected model(): LanguageModel {
    // Chat Completions, not the Responses API, so any OpenAI-compatible
    // endpoint (aimock in CI included) can serve it.
    return this.openai().chat(this.env.OPENAI_MODEL);
  }

  protected openai() {
    return createOpenAI({
      baseURL: this.env.OPENAI_BASE_URL,
      apiKey: this.env.OPENAI_API_KEY || "sk-mock",
    });
  }

  onAGUIRun(run: Run) {
    return streamText({
      model: this.model(),
      instructions: run.instructions(this.prompt),
      messages: run.messages,
      // The client's tools first, so a server tool wins a name clash.
      tools: { ...run.clientTools, ...this.tools(run) },
      stopWhen: stepCountIs(5),
      abortSignal: run.abortSignal,
    });
  }
}

/** Chat with the page's frontend tools (`change_background`, the generative UI renderers). */
export class AgenticChat extends DojoAgent {
  protected prompt =
    "You are the Cloudflare Agents Dojo assistant, running in a Durable Object. Be concise and helpful.";
}

/** Chat with image and document attachments. */
export class AgenticChatMultimodal extends DojoAgent {
  protected prompt =
    "You are the Cloudflare Agents Dojo vision assistant. You can see images and read documents the user attaches; describe or analyse them as asked.";
}

/** Chat whose reasoning streams to the page (a reasoning model on the Responses API). */
export class AgenticChatReasoning extends DojoAgent {
  protected prompt =
    "You are the Cloudflare Agents Dojo thinker. Think the question through, then give a clear, well-structured answer.";

  protected model(): LanguageModel {
    return this.openai().responses(this.env.OPENAI_REASONING_MODEL);
  }

  onAGUIRun(run: Run) {
    return streamText({
      model: this.model(),
      instructions: run.instructions(this.prompt),
      messages: run.messages,
      tools: run.clientTools,
      providerOptions: { openai: { reasoningSummary: "auto" } },
      abortSignal: run.abortSignal,
    });
  }
}

/** A server tool whose result the page renders. */
export class BackendToolRendering extends DojoAgent {
  protected prompt =
    "You are the Cloudflare Agents Dojo forecaster. Call get_weather for any weather question.";

  protected tools(): ToolSet {
    return {
      get_weather: tool({
        description: "Get the current weather for a location.",
        inputSchema: z.object({ location: z.string() }),
        // Canned data keeps the demo deterministic and offline.
        execute: async ({ location }) => ({
          city: location,
          temperature: 20,
          conditions: "sunny",
          humidity: 50,
          windSpeed: 10,
          feelsLike: 25,
        }),
      }),
    };
  }
}

/** The page's `generate_task_steps` frontend tool asks the user to pick steps. */
export class HumanInTheLoop extends DojoAgent {
  protected prompt =
    "You are the Cloudflare Agents Dojo planner. When the user asks for a plan, call generate_task_steps with the steps. After the user has chosen, briefly confirm the plan you will follow.";
}

/** A server tool that pauses for the user's approval (AI SDK `needsApproval`). */
export class HumanInTheLoopApproval extends DojoAgent {
  protected prompt =
    "You are the Cloudflare Agents Dojo refund desk. Call issue_refund when the user asks for a refund. If it was not approved, say the refund was not issued.";

  protected tools(): ToolSet {
    return {
      issue_refund: tool({
        description: "Refund an order. Needs the user's approval.",
        inputSchema: z.object({ order_id: z.string().describe("The order to refund, such as ORD-1001.") }),
        needsApproval: true,
        execute: async ({ order_id }) => ({ order_id, status: "refunded" }),
      }),
    };
  }
}

/** The page's `generate_haiku` frontend tool renders the haiku. */
export class ToolBasedGenerativeUi extends DojoAgent {
  protected prompt =
    "You are the Cloudflare Agents Dojo poet. When the user asks for a haiku, call generate_haiku, then confirm in one short sentence.";
}

/** The page and the agent edit one recipe in shared state. */
export class SharedState extends DojoAgent {
  protected prompt =
    "You are the Cloudflare Agents Dojo chef. You help the user build the recipe shown next to this chat; the shared state below is the current recipe. To create or change it, call generate_recipe with the complete recipe, then confirm in one short sentence.";

  protected tools(): ToolSet {
    return {
      generate_recipe: tool({
        description: "Create or replace the recipe shown in the app. Always pass the complete recipe.",
        inputSchema: z.object({
          recipe: z.object({
            title: z.string(),
            skill_level: z.enum(["Beginner", "Intermediate", "Advanced"]),
            cooking_time: z.enum(["5 min", "15 min", "30 min", "45 min", "60+ min"]).optional(),
            special_preferences: z.array(z.string()).optional(),
            ingredients: z.array(z.object({ icon: z.string(), name: z.string(), amount: z.string() })),
            instructions: z.array(z.string()),
          }),
        }),
        execute: async ({ recipe }) => {
          const current = (this.state.recipe ?? {}) as Record<string, unknown>;
          // The Durable Object keeps it, and the page gets it as a STATE_SNAPSHOT.
          this.setState({ ...this.state, recipe: { ...current, ...recipe } });
          return "Recipe updated.";
        },
      }),
    };
  }
}

/** A plan whose steps complete one by one inside a single tool call. */
export class AgenticGenerativeUi extends DojoAgent {
  protected prompt =
    "You are the Cloudflare Agents Dojo task runner. When the user asks for a plan or a task, call generate_task_steps_generative_ui once with the steps; it shows them in the app and carries them out. Afterwards say in one short sentence that you completed them.";

  protected tools(): ToolSet {
    return {
      generate_task_steps_generative_ui: tool({
        description: "Show a plan in the app and carry it out step by step.",
        inputSchema: z.object({
          steps: z.array(
            z.object({ description: z.string(), status: z.enum(["pending", "completed"]) }),
          ),
        }),
        execute: async ({ steps }) => {
          const plan = steps.map((step) => ({ description: step.description, status: "pending" }));
          this.setState({ ...this.state, steps: plan });
          for (let index = 0; index < plan.length; index++) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            plan[index] = { ...plan[index]!, status: "completed" };
            this.setState({ ...this.state, steps: plan.map((step) => ({ ...step })) });
          }
          return `All ${plan.length} steps are done.`;
        },
      }),
    };
  }
}

/**
 * The document streams into shared state while the model is still writing the
 * page's `write_document` call, before the user confirms it.
 */
export class PredictiveStateUpdates extends DojoAgent {
  protected prompt =
    "You are the Cloudflare Agents Dojo writer. To write or change the document, call write_document with the full updated document in markdown. The shared state below is the current document.";

  onAGUIRun(run: Run) {
    const writeDocument = run.clientTools.write_document;
    let streamed = "";
    const tools: ToolSet = writeDocument
      ? {
          ...run.clientTools,
          write_document: {
            ...writeDocument,
            onInputStart: () => {
              streamed = "";
            },
            onInputDelta: async ({ inputTextDelta }) => {
              streamed += inputTextDelta;
              const { value } = await parsePartialJson(streamed);
              const document = (value as { document?: unknown } | undefined)?.document;
              if (typeof document === "string") run.setState({ ...run.state, document });
            },
          },
        }
      : run.clientTools;

    return streamText({
      model: this.model(),
      instructions: run.instructions(this.prompt),
      messages: run.messages,
      tools,
      stopWhen: stepCountIs(5),
      abortSignal: run.abortSignal,
    });
  }
}
