import type { ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { textOf } from "./lib/fixture-message-text";

/**
 * Generative UI (A2UI 1.0) fixtures. CopilotKit sends its guide as context
 * entries; these fixtures answer only when that context reached the model's
 * request, so a passing test proves the integration injected it.
 *
 * - Markdown transport: the guide starts "Generative UI markdown guide".
 * - Tool transport: the guide starts "Generative UI guide", and the request
 *   offers the render_ui tool the runtime adds.
 */
export const GENERATIVE_UI_PROMPT = "Show me a team plan picker";

/**
 * Every message's text. Adapters put the context in different places: the
 * system prompt (Claude Agent SDK, AG2), a transient model hook (Strands)
 * or the run's message context (Agno). Wherever it lands, the guide can only
 * be in the request if the adapter forwarded RunAgentInput.context.
 */
const requestText = (req: ChatCompletionRequest) =>
  req.messages.map((m) => textOf(m.content)).join("\n");

const lastUserText = (req: ChatCompletionRequest) =>
  textOf(req.messages.filter((m) => m.role === "user").at(-1)?.content);

/**
 * The render_ui tool as the model sees it. Some adapters prefix frontend
 * tools (the Claude Agent SDK serves them as MCP tools, "mcp__…__render_ui").
 */
const renderUITool = (req: ChatCompletionRequest) =>
  req.tools?.find(
    (t) => t.function.name === "render_ui" || t.function.name.endsWith("__render_ui"),
  )?.function.name;

/**
 * The user's prompt is the latest turn. System messages after it are skipped:
 * CopilotKit's LangGraph middleware appends its context message there.
 */
const asksForPlanPicker = (req: ChatCompletionRequest) =>
  req.messages.filter((m) => m.role !== "system").at(-1)?.role === "user" &&
  lastUserText(req).includes(GENERATIVE_UI_PROMPT);

/** The surface both transports render: a title, a seat slider and a bound total. */
export const PLAN_PICKER_OPERATIONS = [
  {
    version: "v1.0",
    createSurface: {
      surfaceId: "plan-picker",
      dataModel: { seats: 5 },
      components: [
        { id: "root", component: "Column", children: ["title", "seats", "total"] },
      ],
    },
  },
  {
    version: "v1.0",
    updateComponents: {
      surfaceId: "plan-picker",
      components: [
        { id: "title", component: "Title", text: "Team plan" },
        {
          id: "seats",
          component: "Slider",
          label: "Seats",
          min: 1,
          max: 50,
          value: { "@path": "/seats" },
        },
        {
          id: "total",
          component: "Text",
          text: {
            "@call": "formatString",
            args: { value: "${/seats} seats selected" },
          },
        },
      ],
    },
  },
];

export function registerGenerativeUIFixtures(server: LLMock) {
  // Markdown transport: the reply carries the operations in an a2ui fence.
  server.addFixture({
    match: {
      predicate: (req) =>
        asksForPlanPicker(req) &&
        requestText(req).includes("Generative UI markdown guide"),
    },
    response: {
      content: [
        "Here is a plan picker.",
        "",
        "```a2ui",
        ...PLAN_PICKER_OPERATIONS.map((op) => JSON.stringify(op)),
        "```",
      ].join("\n"),
    },
  });

  // Tool transport: one render_ui call with the operations.
  server.addFixture({
    match: {
      predicate: (req) =>
        asksForPlanPicker(req) &&
        renderUITool(req) !== undefined &&
        requestText(req).includes("Generative UI guide"),
    },
    response: (req) => ({
      toolCalls: [
        {
          name: renderUITool(req) ?? "render_ui",
          arguments: JSON.stringify({
            target: "chat",
            operations: PLAN_PICKER_OPERATIONS,
          }),
          id: "call_render_plan_picker",
        },
      ],
    }),
  });

  // The turn after the render_ui result, when the agent loops back.
  server.addFixture({
    match: {
      predicate: (req) =>
        req.messages.at(-1)?.role === "tool" &&
        lastUserText(req).includes(GENERATIVE_UI_PROMPT),
    },
    response: { content: "The plan picker is above: move the slider to pick seats." },
  });
}
