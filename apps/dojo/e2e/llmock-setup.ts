import { LLMock, type ChatMessage } from "@copilotkit/llmock";
import * as path from "node:path";

const MOCK_PORT = 5555;
const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures", "openai");

let mockServer: LLMock | null = null;

export async function setupLLMock(): Promise<void> {
  console.log("🔧 Starting LLMock server...");

  // Small per-chunk latency prevents crew-ai's asyncio event loop from
  // getting congested by zero-latency streaming (real OpenAI has natural
  // network delays between chunks; LLMock needs to simulate this).
  mockServer = new LLMock({ port: MOCK_PORT, latency: 5 });

  // Extract text from message content — handles both string and array-of-parts
  // (Strands SDK sends content as [{type: "text", text: "..."}])
  const textOf = (content: ChatMessage["content"] | undefined): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text!)
        .join("");
    }
    return "";
  };

  // LangGraph HITL: the LangGraph agent registers tool `plan_execution_steps`,
  // not `generate_task_steps`. The JSON fixture returns `generate_task_steps`
  // which CopilotKit's useHumanInTheLoop() handles (wrong UI: Confirm/Reject).
  // LangGraph needs the correct tool name so chatNode routes to processStepsNode,
  // which calls interrupt() and triggers useLangGraphInterrupt() (correct UI:
  // Perform Steps). These predicate fixtures MUST come before loadFixtureFile.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLangGraphTool = req.tools?.some(
          (t) => t.function.name === "plan_execution_steps",
        );
        return (
          !!hasLangGraphTool &&
          textOf(lastUser?.content).includes("one step with eggs")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "plan_execution_steps",
          arguments: JSON.stringify({
            steps: [
              { description: "Crack eggs into bowl", status: "enabled" },
              { description: "Preheat oven to 350F", status: "enabled" },
              { description: "Mix and bake for 25 min", status: "enabled" },
            ],
          }),
        },
      ],
    },
  });
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLangGraphTool = req.tools?.some(
          (t) => t.function.name === "plan_execution_steps",
        );
        return (
          !!hasLangGraphTool &&
          textOf(lastUser?.content).includes("Start The Planning")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "plan_execution_steps",
          arguments: JSON.stringify({
            steps: [
              { description: "Start The Planning", status: "enabled" },
              { description: "Design spacecraft", status: "enabled" },
              { description: "Launch mission", status: "enabled" },
            ],
          }),
        },
      ],
    },
  });

  // Load HITL fixtures — they share a "plan to make brownies" substring
  // with agentic-gen-ui fixtures, and first-match-wins. By loading HITL first,
  // "one step with eggs" matches HITL tests before "plan to make brownies"
  // matches the agenticGenUI fixture (which returns the wrong tool name).
  // NOTE: LangGraph predicate fixtures above take priority over these for
  // requests containing plan_execution_steps in the tools list.
  mockServer.loadFixtureFile(path.join(FIXTURES_DIR, "human-in-the-loop.json"));

  const sysContent = (msgs: ChatMessage[]) =>
    msgs.find((m) => m.role === "system")?.content ?? "";
  // Case-insensitive check for system prompt content — Python booleans are
  // True/False (capitalized) while JavaScript uses true/false (lowercase).
  const sysIncludes = (msgs: ChatMessage[], substr: string) => {
    const sys =
      typeof sysContent(msgs) === "string" ? (sysContent(msgs) as string) : "";
    return sys.toLowerCase().includes(substr.toLowerCase());
  };
  const supervisorRoute = (nextAgent: string, answer: string) => ({
    response: {
      toolCalls: [
        {
          name: "supervisor_response",
          arguments: JSON.stringify({ answer, next_agent: nextAgent }),
        },
      ],
    },
  });

  // Supervisor: no flights yet → route to flights_agent
  mockServer.addFixture({
    match: {
      predicate: (req) =>
        sysIncludes(req.messages, "Flights found: false"),
    },
    ...supervisorRoute("flights_agent", "Let me find flights for you!"),
  });
  // Supervisor: flights found, no hotels → route to hotels_agent
  mockServer.addFixture({
    match: {
      predicate: (req) =>
        sysIncludes(req.messages, "Flights found: true") &&
        sysIncludes(req.messages, "Hotels found: false"),
    },
    ...supervisorRoute(
      "hotels_agent",
      "Great choice! Now let me find hotels for you.",
    ),
  });
  // Supervisor: flights + hotels done, experiences not yet → route to experiences_agent
  // NOTE: state.experiences has no default (undefined), so hasExperiences is always "true"
  // in the system prompt. We distinguish by checking if the experiences agent's
  // response text is already in the messages.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const experiencesDone = req.messages.some(
          (m) =>
            m.role === "assistant" &&
            textOf(m.content).includes("wonderful experiences"),
        );
        return (
          sysIncludes(req.messages, "Hotels found: true") && !experiencesDone
        );
      },
    },
    ...supervisorRoute(
      "experiences_agent",
      "Excellent! Now let me find some experiences for you.",
    ),
  });
  // Supervisor: all agents completed → route to complete
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const experiencesDone = req.messages.some(
          (m) =>
            m.role === "assistant" &&
            textOf(m.content).includes("wonderful experiences"),
        );
        return (
          sysIncludes(req.messages, "Hotels found: true") && experiencesDone
        );
      },
    },
    ...supervisorRoute("complete", "Your travel plan is all set!"),
  });
  // Experiences agent's own ChatOpenAI call — returns generic text
  mockServer.addFixture({
    match: {
      predicate: (req) =>
        sysIncludes(req.messages, "You are the experiences agent"),
    },
    response: {
      content:
        "I've found some wonderful experiences for your trip to San Francisco!",
    },
  });

  // Strands agentic gen UI: the Strands agent registers plan_task_steps,
  // not generate_task_steps_generative_ui. Predicate fixtures detect the
  // Strands tool name in the request and return the correct tool call.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasStrandsTool = req.tools?.some(
          (t) => t.function.name === "plan_task_steps",
        );
        return (
          !!hasStrandsTool &&
          textOf(lastUser?.content).includes("plan to make brownies")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "plan_task_steps",
          arguments: JSON.stringify({
            task: "make brownies",
            context: "",
            steps: [
              { description: "Gather ingredients", status: "pending" },
              {
                description: "Melt butter and mix with cocoa",
                status: "pending",
              },
              { description: "Add eggs and flour", status: "pending" },
              { description: "Bake at 350F for 25 min", status: "pending" },
            ],
          }),
        },
      ],
    },
  });
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasStrandsTool = req.tools?.some(
          (t) => t.function.name === "plan_task_steps",
        );
        return (
          !!hasStrandsTool && textOf(lastUser?.content).includes("Go to Mars")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "plan_task_steps",
          arguments: JSON.stringify({
            task: "Go to Mars",
            context: "",
            steps: [
              { description: "Design spacecraft", status: "pending" },
              { description: "Assemble crew", status: "pending" },
              { description: "Launch from Earth", status: "pending" },
              { description: "Land on Mars", status: "pending" },
            ],
          }),
        },
      ],
    },
  });

  // Shared state: ADK/Strands use generate_recipe (not updateWorkingMemory).
  // The JSON fixture in shared-state.json returns updateWorkingMemory which
  // only works for CopilotKit frameworks (Agno/LangGraph). These predicate
  // fixtures fire first for ADK and Strands (which both register generate_recipe).
  const recipeData = {
    title: "Pasta Aglio e Olio",
    skill_level: "Intermediate",
    special_preferences: [] as string[],
    cooking_time: "45 min",
    ingredients: [
      { icon: "🍝", name: "Pasta", amount: "400g" },
      { icon: "🧂", name: "Salt", amount: "1 tsp" },
      { icon: "🫒", name: "Olive Oil", amount: "4 tbsp" },
      { icon: "🧄", name: "Garlic", amount: "6 cloves" },
      { icon: "🍅", name: "Tomatoes", amount: "2 cups" },
    ],
    instructions: [
      "Boil water and cook pasta until al dente",
      "Slice garlic thinly and sauté in olive oil",
      "Dice tomatoes and add to the pan",
      "Season with salt to taste",
      "Toss pasta with the sauce and serve",
    ],
    changes: "",
  };
  // Strands/CrewAI/LangGraph: generate_recipe(recipe: Recipe) — nested {recipe: {...}} args.
  // These frameworks wrap recipe data under a "recipe" key. Discriminate from ADK
  // (flat args) via two signals: (1) tool schema has parameters.properties.recipe
  // (available in OpenAI-format requests), or (2) system prompt contains
  // "helpful recipe assistant" (Strands — whose Gemini SDK omits parameter
  // schemas from functionDeclarations).
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const recipeTool = req.tools?.find(
          (t) => t.function.name === "generate_recipe",
        );
        const hasNestedRecipeParam = !!(
          (recipeTool?.function.parameters as Record<string, unknown>)
            ?.properties as Record<string, unknown>
        )?.recipe;
        return (
          !!recipeTool &&
          (hasNestedRecipeParam ||
            sysIncludes(req.messages, "helpful recipe assistant")) &&
          textOf(lastUser?.content).includes("pasta recipe")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "generate_recipe",
          arguments: JSON.stringify({ recipe: recipeData }),
        },
      ],
    },
  });
  // ADK: generate_recipe(skill_level, title, ...) — flat argument format.
  // Falls through when neither tool schema nor system prompt indicates nested args.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const recipeTool = req.tools?.find(
          (t) => t.function.name === "generate_recipe",
        );
        const hasNestedRecipeParam = !!(
          (recipeTool?.function.parameters as Record<string, unknown>)
            ?.properties as Record<string, unknown>
        )?.recipe;
        return (
          !!recipeTool &&
          !hasNestedRecipeParam &&
          !sysIncludes(req.messages, "helpful recipe assistant") &&
          textOf(lastUser?.content).includes("pasta recipe")
        );
      },
    },
    response: {
      toolCalls: [
        { name: "generate_recipe", arguments: JSON.stringify(recipeData) },
      ],
    },
  });

  // Pydantic AI shared state: the agent registers display_recipe,
  // not updateWorkingMemory. The Recipe model differs from ADK/Strands
  // (no title/changes fields, StrEnum values for skill_level/cooking_time).
  // IMPORTANT: pydantic-ai's single_arg_name optimization means a tool with
  // one model-like parameter (e.g. display_recipe(recipe: Recipe)) uses the
  // model's schema directly as the tool JSON schema — so the arguments must
  // be the Recipe fields at the top level, NOT wrapped in {"recipe": {...}}.
  const pydanticRecipeData = {
    skill_level: "Intermediate",
    special_preferences: [] as string[],
    cooking_time: "45 min",
    ingredients: [
      { icon: "🍝", name: "Pasta", amount: "400g" },
      { icon: "🧂", name: "Salt", amount: "1 tsp" },
      { icon: "🫒", name: "Olive Oil", amount: "4 tbsp" },
      { icon: "🧄", name: "Garlic", amount: "6 cloves" },
      { icon: "🍅", name: "Tomatoes", amount: "2 cups" },
    ],
    instructions: [
      "Boil water and cook pasta until al dente",
      "Slice garlic thinly and sauté in olive oil",
      "Dice tomatoes and add to the pan",
      "Season with salt to taste",
      "Toss pasta with the sauce and serve",
    ],
  };
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasPydanticTool = req.tools?.some(
          (t) => t.function.name === "display_recipe",
        );
        return (
          !!hasPydanticTool &&
          textOf(lastUser?.content).includes("pasta recipe")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "display_recipe",
          arguments: JSON.stringify(pydanticRecipeData),
        },
      ],
    },
  });

  // Pydantic AI agentic gen UI: the agent registers create_plan,
  // not generate_task_steps_generative_ui. Predicate fixtures detect the
  // Pydantic AI tool name and return the correct tool call.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasPydanticTool = req.tools?.some(
          (t) => t.function.name === "create_plan",
        );
        return (
          !!hasPydanticTool &&
          textOf(lastUser?.content).includes("plan to make brownies")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "create_plan",
          arguments: JSON.stringify({
            steps: [
              "Gather ingredients",
              "Melt butter and mix with cocoa",
              "Add eggs and flour",
              "Bake at 350F for 25 min",
            ],
          }),
        },
      ],
    },
  });
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasPydanticTool = req.tools?.some(
          (t) => t.function.name === "create_plan",
        );
        return (
          !!hasPydanticTool && textOf(lastUser?.content).includes("Go to Mars")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "create_plan",
          arguments: JSON.stringify({
            steps: [
              "Design spacecraft",
              "Assemble crew",
              "Launch from Earth",
              "Land on Mars",
            ],
          }),
        },
      ],
    },
  });

  // Langroid agentic gen UI: Langroid embeds tool definitions in the system
  // message text (TOOL: create_plan) instead of using the OpenAI tools array.
  // Detect via system message content since req.tools will be empty.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLangroidTool = sysIncludes(req.messages, "TOOL: create_plan");
        return (
          !!hasLangroidTool &&
          textOf(lastUser?.content).includes("plan to make brownies")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "create_plan",
          arguments: JSON.stringify({
            request: "create_plan",
            steps: [
              "Gather ingredients",
              "Melt butter and mix with cocoa",
              "Add eggs and flour",
              "Bake at 350F for 25 min",
            ],
          }),
        },
      ],
    },
  });
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLangroidTool = sysIncludes(req.messages, "TOOL: create_plan");
        return (
          !!hasLangroidTool && textOf(lastUser?.content).includes("Go to Mars")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "create_plan",
          arguments: JSON.stringify({
            request: "create_plan",
            steps: [
              "Design spacecraft",
              "Assemble crew",
              "Launch from Earth",
              "Land on Mars",
            ],
          }),
        },
      ],
    },
  });

  // Langroid shared state: Langroid embeds generate_recipe in the system message.
  // The recipe arg is nested under "recipe" key like Strands/CrewAI/LangGraph.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLangroidTool = sysIncludes(
          req.messages,
          "TOOL: generate_recipe",
        );
        return (
          !!hasLangroidTool &&
          textOf(lastUser?.content).includes("pasta recipe")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "generate_recipe",
          arguments: JSON.stringify({
            request: "generate_recipe",
            recipe: recipeData,
          }),
        },
      ],
    },
  });

  // LlamaIndex agentic gen UI: the agent registers run_task (a backend tool),
  // not generate_task_steps_generative_ui. The run_task tool takes a Task
  // model with steps: list[Step], where each Step has a description string.
  // Arguments are wrapped in {"task": {...}} since llama-index exposes the
  // function parameter name as the top-level key.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLlamaIndexTool = req.tools?.some(
          (t) => t.function.name === "run_task",
        );
        return (
          !!hasLlamaIndexTool &&
          textOf(lastUser?.content).includes("plan to make brownies")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "run_task",
          arguments: JSON.stringify({
            task: {
              steps: [
                { description: "Gather ingredients" },
                { description: "Melt butter and mix with cocoa" },
                { description: "Add eggs and flour" },
                { description: "Bake at 350F for 25 min" },
              ],
            },
          }),
        },
      ],
    },
  });
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLlamaIndexTool = req.tools?.some(
          (t) => t.function.name === "run_task",
        );
        return (
          !!hasLlamaIndexTool &&
          textOf(lastUser?.content).includes("Go to Mars")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "run_task",
          arguments: JSON.stringify({
            task: {
              steps: [
                { description: "Design spacecraft" },
                { description: "Assemble crew" },
                { description: "Launch from Earth" },
                { description: "Land on Mars" },
              ],
            },
          }),
        },
      ],
    },
  });

  // LlamaIndex shared state: the agent registers update_recipe (a frontend
  // tool), not updateWorkingMemory. The Recipe model has skill_level,
  // special_preferences, cooking_time, ingredients, instructions (no title
  // or changes). Arguments are wrapped in {"recipe": {...}}.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const hasLlamaIndexTool = req.tools?.some(
          (t) => t.function.name === "update_recipe",
        );
        return (
          !!hasLlamaIndexTool &&
          textOf(lastUser?.content).includes("pasta recipe")
        );
      },
    },
    response: {
      toolCalls: [
        {
          name: "update_recipe",
          arguments: JSON.stringify({
            recipe: pydanticRecipeData,
          }),
        },
      ],
    },
  });

  // Load all fixture JSON files from the fixtures directory
  // (HITL fixtures are duplicated but the earlier copies match first)
  mockServer.loadFixtureDir(FIXTURES_DIR);

  // Programmatic catch-all: when the last message is a tool result,
  // return a generic text acknowledgment. This must be added AFTER
  // fixture files so it appears last in the fixture list — but
  // fixture-file entries only match on userMessage (substring), and
  // a follow-up request after a tool call still has the same last
  // user message, so we need this predicate to fire FIRST.
  // Insert at position 0 so it's checked before file-based fixtures.
  // Prepend so it matches before substring-based fixtures on follow-up requests
  mockServer.prependFixture({
    match: {
      predicate: (req) => {
        const last = req.messages[req.messages.length - 1];
        return last?.role === "tool";
      },
    },
    response: { content: "Done! I've completed that for you." },
  });

  // Universal catch-all: matches any request that wasn't handled above.
  // Appended LAST so specific fixtures always take priority.
  // Log unmatched requests for debugging fixture mismatches.
  mockServer.addFixture({
    match: {
      predicate: (req) => {
        const lastUser = req.messages.filter((m) => m.role === "user").pop();
        const userText = lastUser ? textOf(lastUser.content) : "(no user msg)";
        const toolNames =
          req.tools?.map((t) => t.function.name).join(",") ||
          "(no tools)";
        const contentType = lastUser ? typeof lastUser.content : "N/A";
        const contentSample = lastUser
          ? JSON.stringify(lastUser.content).slice(0, 120)
          : "N/A";
        console.error(
          `[LLMock CATCH-ALL] model=${req.model} lastUser="${userText.slice(0, 80)}" tools=[${toolNames}] msgs=${req.messages.length} contentType=${contentType} content=${contentSample}`,
        );
        return true;
      },
    },
    response: { content: "I understand. How can I help you with that?" },
  });

  // Log fixture counts for debugging
  const allFixtures = mockServer.getFixtures();
  const predicateCount = allFixtures.filter((f) => f.match.predicate).length;
  const userMsgCount = allFixtures.filter((f) => f.match.userMessage).length;
  console.log(
    `   Fixture stats: ${allFixtures.length} total, ${predicateCount} predicate, ${userMsgCount} userMessage`,
  );
  // Log the userMessage fixtures to verify they loaded
  allFixtures.forEach((f, i) => {
    if (f.match.userMessage) {
      console.log(
        `     [${i}] userMessage: "${String(f.match.userMessage).slice(0, 50)}"`,
      );
    }
  });

  const url = await mockServer.start();
  console.log(`✅ LLMock server running at ${url}`);
  console.log(`   Fixtures loaded from: ${FIXTURES_DIR}`);

  // Export the URL for child processes to use
  process.env.LLMOCK_URL = `${url}/v1`;
}

export async function teardownLLMock(): Promise<void> {
  if (mockServer) {
    console.log("🧹 Stopping LLMock server...");
    await mockServer.stop();
    mockServer = null;
    console.log("✅ LLMock server stopped");
  }
}

export function getMockServer(): LLMock | null {
  return mockServer;
}
