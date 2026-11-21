/**
 * Deterministic model fixtures for the Cloudflare Agents Dojo Worker
 * (integrations/community/cloudflare-agents/typescript/examples). Every demo
 * agent's system prompt names it ("Cloudflare Agents Dojo <role>", see
 * examples/src/agents.ts), and every predicate here is scoped to one of those
 * phrases, so these responses cannot intercept another integration.
 *
 * Responses are reused from the shared fixtures (fixtures/openai/*.json)
 * wherever the page asserts the same content for every integration. The
 * replies that prove something reached the model (the image, the shared
 * state, the user's choice in a tool result) are built from the request.
 *
 * The reasoning demo calls the OpenAI Responses API. aimock turns those
 * requests into the same chat shape (instructions and developer messages
 * become `system` messages) and tags them `endpoint: "chat"`, so the same
 * predicates serve both APIs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ChatCompletionRequest,
  ChatMessage,
  LLMock,
} from "@copilotkit/aimock";

/**
 * The multimodal answer. Only the fixture that finds the image in the request
 * gives it, so the spec passes only when the image reached the model.
 */
export const CLOUDFLARE_IMAGE_SEEN =
  "I can see the image you attached: it reached me as an image part, so I can describe its visual content for you.";

/** One phrase per demo agent, from its system prompt. */
const PROMPTS = {
  chat: /Cloudflare Agents Dojo assistant/i,
  vision: /Cloudflare Agents Dojo vision assistant/i,
  thinker: /Cloudflare Agents Dojo thinker/i,
  forecaster: /Cloudflare Agents Dojo forecaster/i,
  planner: /Cloudflare Agents Dojo planner/i,
  refundDesk: /Cloudflare Agents Dojo refund desk/i,
  poet: /Cloudflare Agents Dojo poet/i,
  chef: /Cloudflare Agents Dojo chef/i,
  taskRunner: /Cloudflare Agents Dojo task runner/i,
  writer: /Cloudflare Agents Dojo writer/i,
} as const;

type Demo = keyof typeof PROMPTS;

/** The header `run.instructions()` puts above the shared state JSON. */
const SHARED_STATE_HEADER =
  "Shared state (the application shows it to the user and can change it):";

/**
 * Characters per streamed chunk for the writer's document, so its
 * `write_document` arguments arrive as many deltas: the agent streams
 * `state.document` from them, which is what the predictive-state spec checks.
 */
const DOCUMENT_CHUNK_SIZE = 25;

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures", "openai");

type SharedFixture = {
  match: { userMessage?: string };
  response: Record<string, unknown>;
};

type ToolCall = { name: string; arguments: string; id?: string };

function sharedResponse(file: string, userMessage: string) {
  const raw = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, `${file}.json`), "utf8"),
  );
  const fixtures: SharedFixture[] = Array.isArray(raw) ? raw : raw.fixtures;
  const found = fixtures.find((f) => f.match.userMessage === userMessage);
  if (!found) {
    throw new Error(`No shared fixture for "${userMessage}" in ${file}.json`);
  }
  return found.response;
}

function sharedToolCall(file: string, userMessage: string): ToolCall {
  const calls = sharedResponse(file, userMessage).toolCalls as ToolCall[];
  return calls[0]!;
}

function sharedContent(file: string, userMessage: string): string {
  return sharedResponse(file, userMessage).content as string;
}

const textOf = (content: ChatMessage["content"] | undefined): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text!)
      .join("");
  }
  return "";
};

const systemText = (request: ChatCompletionRequest): string =>
  request.messages
    .filter((message) => message.role === "system")
    .map((message) => textOf(message.content))
    .join("\n");

const lastUserMessage = (request: ChatCompletionRequest) =>
  request.messages.filter((m) => m.role === "user").pop();

const lastUserText = (request: ChatCompletionRequest): string =>
  textOf(lastUserMessage(request)?.content);

// Only the conversation's final message decides a tool-result turn; one tool
// call earlier in history must not reroute later user turns.
const isToolResultTurn = (request: ChatCompletionRequest): boolean =>
  request.messages[request.messages.length - 1]?.role === "tool";

// Tool-call ids must differ per turn: a client treats a repeated
// TOOL_CALL_START id as a replay and appends the new arguments to the earlier
// call.
const userTurn = (request: ChatCompletionRequest): number =>
  request.messages.filter((m) => m.role === "user").length;

const hasTool = (request: ChatCompletionRequest, name: string): boolean =>
  !!request.tools?.some((t) => t.function.name === name);

/** The demo whose agent sent this request, if it is one of the Worker's. */
function demoOf(request: ChatCompletionRequest): Demo | undefined {
  const system = systemText(request);
  return (Object.keys(PROMPTS) as Demo[]).find((demo) =>
    PROMPTS[demo].test(system),
  );
}

/** A user turn (not a tool-result turn) of `demo`. */
const userTurnOf =
  (
    demo: Demo,
    test: (request: ChatCompletionRequest) => boolean = () => true,
  ) =>
  (request: ChatCompletionRequest): boolean =>
    PROMPTS[demo].test(systemText(request)) &&
    !isToolResultTurn(request) &&
    test(request);

/** `call` with an id unique to this turn of the conversation. */
const callThisTurn = (call: ToolCall, request: ChatCompletionRequest) => ({
  toolCalls: [
    {
      id: `call_cf_${call.name}_${userTurn(request)}`,
      name: call.name,
      arguments: call.arguments,
    },
  ],
});

/** Parses JSON, unwrapping a JSON string that holds JSON. */
function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" ? parseJson(value) : value;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The tool results of the current turn: the trailing run of tool messages. */
function currentToolResults(request: ChatCompletionRequest): ChatMessage[] {
  const results: ChatMessage[] = [];
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]!;
    if (message.role !== "tool") break;
    results.push(message);
  }
  return results;
}

/** The arguments of the assistant's call that `result` answers. */
function callArguments(
  request: ChatCompletionRequest,
  result: ChatMessage,
): Record<string, unknown> | undefined {
  for (const message of request.messages) {
    const call = message.tool_calls?.find((c) => c.id === result.tool_call_id);
    if (call) {
      const args = parseJson(call.function.arguments);
      return isRecord(args) ? args : undefined;
    }
  }
  return undefined;
}

/** The latest `generate_task_steps` answer from the page in this thread. */
function plannerSelection(
  request: ChatCompletionRequest,
): { accepted: boolean; steps: string[] } | undefined {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]!;
    if (message.role !== "tool") continue;
    const value = parseJson(textOf(message.content));
    if (!isRecord(value) || typeof value.accepted !== "boolean") continue;
    const steps = Array.isArray(value.steps) ? value.steps : [];
    return {
      accepted: value.accepted,
      steps: steps
        .map((step) => (isRecord(step) ? step.description : undefined))
        .filter((d): d is string => typeof d === "string"),
    };
  }
  return undefined;
}

/** The shared state the agent put into its system prompt. */
function sharedStateOf(request: ChatCompletionRequest): unknown {
  const system = systemText(request);
  const at = system.indexOf(SHARED_STATE_HEADER);
  if (at === -1) return undefined;
  const rest = system.slice(at + SHARED_STATE_HEADER.length).trim();
  // The state is the instructions' last section, and pretty-printed JSON has
  // no blank lines, so it ends at the end of the text or at the next section.
  return parseJson(rest) ?? parseJson(rest.split("\n\n")[0]!);
}

/** The reply to a tool-result turn of a Cloudflare demo, or null. */
function toolResultReply(request: ChatCompletionRequest): string | null {
  if (!isToolResultTurn(request)) return null;
  const results = currentToolResults(request);
  switch (demoOf(request)) {
    case undefined:
      return null;
    case "chat":
      return "Done, the background is updated.";
    case "forecaster":
      return "It is sunny and 20°C.";
    case "planner": {
      // The page answers generate_task_steps with the steps the user kept.
      const selection = plannerSelection(request);
      if (!selection?.accepted) return "Understood, I won't follow that plan.";
      return `I'll follow the steps you selected: ${selection.steps.join(", ")}.`;
    }
    case "refundDesk": {
      // An approved call ran the tool ({ order_id, status: "refunded" }); a
      // rejected one comes back as the AI SDK's execution-denied text.
      const result = results[0]!;
      const output = parseJson(textOf(result.content));
      const orderId =
        (isRecord(output) && output.order_id) ||
        callArguments(request, result)?.order_id ||
        "the order";
      return isRecord(output) && output.status === "refunded"
        ? `Done: ${orderId} has been refunded.`
        : `Understood: ${orderId} was not refunded.`;
    }
    case "poet":
      return "Here is your haiku.";
    case "chef":
      return "Done, the recipe is in the recipe card now.";
    case "taskRunner":
      return "Done! I've completed every step of the plan.";
    case "writer": {
      // The page answers write_document with { accepted }.
      const rejected = results.some((result) => {
        const value = parseJson(textOf(result.content));
        return isRecord(value) && value.accepted === false;
      });
      return rejected
        ? "Understood, I discarded that edit and left the document as it was."
        : "I updated the document as requested.";
    }
    case "vision":
    case "thinker":
      return "Done.";
  }
}

/**
 * True for a Cloudflare Agents tool-result turn these fixtures answer: every
 * demo's. aimock-setup.ts keeps its generic tool-result acknowledgment off
 * them, since several specs assert replies that depend on the tool's result.
 */
export function isCloudflareAgentsToolResultTurn(
  request: ChatCompletionRequest,
): boolean {
  return toolResultReply(request) !== null;
}

export function registerCloudflareAgentsFixtures(mockServer: LLMock): void {
  // Every demo's tool-result turn. Built from the same function as the
  // carve-out above, so the two cannot drift apart.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: (request) => toolResultReply(request) !== null,
    },
    response: (request) => ({ content: toolResultReply(request)! }),
  });

  // Agentic chat: frontend tool call (change_background) on request.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: userTurnOf(
        "chat",
        (request) =>
          hasTool(request, "change_background") &&
          /background/i.test(lastUserText(request)),
      ),
    },
    response: (request) => {
      const color = /pink/i.test(lastUserText(request)) ? "pink" : "blue";
      return {
        toolCalls: [
          {
            id: `call_cf_change_background_${color}_${userTurn(request)}`,
            name: "change_background",
            arguments: JSON.stringify({ background: color }),
          },
        ],
      };
    },
  });

  // Agentic chat: plain greeting, echoing the user's name.
  mockServer.addFixture({
    match: { endpoint: "chat", predicate: userTurnOf("chat") },
    response: (request) => {
      const name = /\bI am (\w+)/i.exec(lastUserText(request))?.[1];
      return {
        content: name
          ? `Hello ${name}! I'm a Cloudflare Agent. How can I help?`
          : "Hello from a Cloudflare Agent! How can I help?",
      };
    },
  });

  // Backend tool rendering: call the Worker's own get_weather tool.
  mockServer.addFixture({
    match: { endpoint: "chat", predicate: userTurnOf("forecaster") },
    response: (request) => {
      const location = /new york/i.test(lastUserText(request))
        ? "New York"
        : "San Francisco";
      return {
        toolCalls: [
          {
            id: `call_cf_get_weather_${userTurn(request)}`,
            name: "get_weather",
            arguments: JSON.stringify({ location }),
          },
        ],
      };
    },
  });

  // Multimodal: answer about the image only when the user message carries it
  // as an image part. A dropped attachment gets a reply the spec rejects.
  mockServer.addFixture({
    match: { endpoint: "chat", predicate: userTurnOf("vision") },
    response: (request) => {
      const content = lastUserMessage(request)?.content;
      const hasImage =
        Array.isArray(content) &&
        content.some(
          (part) =>
            part.type === "image_url" &&
            !!(part as { image_url?: { url?: string } }).image_url?.url,
        );
      return {
        content: hasImage
          ? CLOUDFLARE_IMAGE_SEEN
          : "I don't see an image in your message. Please attach one.",
      };
    },
  });

  // Reasoning (Responses API): the shared response carries a `reasoning`
  // channel, which aimock streams as reasoning summary events. aimock emits it
  // because the demo's model (o4-mini) is reasoning-capable.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: userTurnOf("thinker", (request) =>
        lastUserText(request).includes("best car to buy"),
      ),
    },
    response: sharedResponse("agentic-chat-reasoning", "best car to buy"),
  });

  // Human in the loop: the page's generate_task_steps tool asks the user to
  // pick the steps; the reply to it is the tool-result fixture above.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: userTurnOf("planner", (request) =>
        /^\s*hi\b/i.test(lastUserText(request)),
      ),
    },
    response: { content: sharedContent("agentic-chat", "Hi") },
  });
  // "Does the planner include X?" is answered from the steps the page sent
  // back, which proves the user's choice reached the model. Registered before
  // the plan fixtures: "Does the planner include Start The Planning?" also
  // contains that plan's prompt, and the first matching fixture wins.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: userTurnOf("planner", (request) =>
        lastUserText(request).includes("Does the planner include"),
      ),
    },
    response: (request) => {
      const asked = /Does the planner include (.+?)\?/i
        .exec(lastUserText(request))?.[1]
        ?.toLowerCase();
      const selection = plannerSelection(request);
      if (!asked || !selection) {
        return { content: "I don't know which steps you selected." };
      }
      const included = selection.steps.some((step) =>
        step.toLowerCase().includes(asked),
      );
      return { content: included ? "Yes" : "No" };
    },
  });
  for (const prompt of ["one step with eggs", "Start The Planning"]) {
    mockServer.addFixture({
      match: {
        endpoint: "chat",
        predicate: userTurnOf("planner", (request) =>
          lastUserText(request).includes(prompt),
        ),
      },
      response: (request) =>
        callThisTurn(sharedToolCall("human-in-the-loop", prompt), request),
    });
  }

  // Human in the loop with approval: the Worker's issue_refund tool needs
  // approval, so this call ends the run with a tool_approval interrupt. The
  // reply after the decision is the tool-result fixture above.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: userTurnOf(
        "refundDesk",
        (request) =>
          hasTool(request, "issue_refund") &&
          /\bORD-\d+\b/.test(lastUserText(request)),
      ),
    },
    response: (request) => ({
      toolCalls: [
        {
          id: `call_cf_issue_refund_${userTurn(request)}`,
          name: "issue_refund",
          arguments: JSON.stringify({
            order_id: /\bORD-\d+\b/.exec(lastUserText(request))![0],
          }),
        },
      ],
    }),
  });

  // Tool-based generative UI: the page's generate_haiku tool, two haikus.
  for (const prompt of ["I will always win", "moon shines bright"]) {
    mockServer.addFixture({
      match: {
        endpoint: "chat",
        predicate: userTurnOf("poet", (request) =>
          lastUserText(request).includes(prompt),
        ),
      },
      response: (request) =>
        callThisTurn(sharedToolCall("tool-based-gen-ui", prompt), request),
    });
  }

  // Shared state: the Worker's generate_recipe tool writes state.recipe,
  // which the page receives as a STATE_SNAPSHOT. The shared recipe keeps the
  // page's assertions the same as for every other integration.
  const sharedRecipe = JSON.parse(
    sharedToolCall("shared-state", "pasta recipe").arguments,
  ).memory.recipe;
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: userTurnOf("chef", (request) =>
        lastUserText(request).includes("pasta recipe"),
      ),
    },
    response: (request) =>
      callThisTurn(
        {
          name: "generate_recipe",
          arguments: JSON.stringify({
            recipe: { title: "Pasta al Pomodoro", ...sharedRecipe },
          }),
        },
        request,
      ),
  });
  // The ingredients are listed from the shared state in the system prompt,
  // so the ones the user added in the UI show up only if the state arrived.
  // After the recipe fixture: the recipe prompt ("one of the ingredients
  // should be ...") contains this one's, and the first matching fixture wins.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: userTurnOf("chef", (request) =>
        lastUserText(request).includes("the ingredients"),
      ),
    },
    response: (request) => {
      const state = sharedStateOf(request);
      const recipe = isRecord(state) ? state.recipe : undefined;
      const ingredients =
        isRecord(recipe) && Array.isArray(recipe.ingredients)
          ? recipe.ingredients.filter(isRecord)
          : [];
      if (ingredients.length === 0) {
        return { content: "I can't see a recipe yet." };
      }
      const lines = ingredients.map(
        (ingredient) => `- ${ingredient.name}: ${ingredient.amount}`,
      );
      return { content: `Here are the ingredients:\n${lines.join("\n")}` };
    },
  });

  // Agentic generative UI: the Worker's generate_task_steps_generative_ui
  // tool streams the plan's progress into state.steps.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: userTurnOf("taskRunner", (request) =>
        /^\s*hi\b/i.test(lastUserText(request)),
      ),
    },
    response: { content: sharedContent("agentic-chat", "Hi") },
  });
  for (const prompt of ["plan to make brownies", "Go to Mars"]) {
    mockServer.addFixture({
      match: {
        endpoint: "chat",
        predicate: userTurnOf("taskRunner", (request) =>
          lastUserText(request).includes(prompt),
        ),
      },
      response: (request) =>
        callThisTurn(sharedToolCall("agentic-gen-ui", prompt), request),
    });
  }

  // Predictive state updates: the page's write_document tool. The agent
  // streams state.document from its arguments while they stream, so they go
  // out in small chunks. The documents are the shared ones (written there for
  // a differently named tool).
  for (const prompt of [
    "dragon called Atlantis",
    "Change dragon name to Lola",
  ]) {
    mockServer.addFixture({
      match: {
        endpoint: "chat",
        predicate: userTurnOf(
          "writer",
          (request) =>
            hasTool(request, "write_document") &&
            lastUserText(request).includes(prompt),
        ),
      },
      chunkSize: DOCUMENT_CHUNK_SIZE,
      response: (request) =>
        callThisTurn(
          {
            name: "write_document",
            arguments: sharedToolCall("predictive-state", prompt).arguments,
          },
          request,
        ),
    });
  }

  // Any other user turn of a Cloudflare demo: say so, rather than fall through
  // to an unscoped shared fixture that could make a broken scope pass.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: (request) =>
        demoOf(request) !== undefined && !isToolResultTurn(request),
    },
    response: (request) => ({
      content: `No Cloudflare Agents fixture for the ${demoOf(request)} demo and "${lastUserText(request).slice(0, 80)}".`,
    }),
  });
}
