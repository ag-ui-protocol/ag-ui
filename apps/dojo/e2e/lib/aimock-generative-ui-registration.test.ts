import assert from "node:assert/strict";
import test from "node:test";
import {
  LLMock,
  matchFixture,
  type ChatCompletionRequest,
  type ChatMessage,
  type ToolDefinition,
} from "@copilotkit/aimock";
import { registerLLMockFixtures } from "../aimock-setup";
import {
  CATALOG_EVIDENCE,
  GENERATIVE_UI_PROMPT,
  MARKDOWN_GUIDE,
  TOOL_GUIDE,
} from "../generative-ui-fixtures";

const mockServer = new LLMock();
registerLLMockFixtures(mockServer);

/** The response of the fixture the full registry serves for `input`. */
async function composedResponse(input: ChatCompletionRequest) {
  const fixture = matchFixture([...mockServer.getFixtures()], input);
  if (!fixture) return undefined;
  return typeof fixture.response === "function"
    ? await fixture.response(input)
    : fixture.response;
}

// Context entries as CopilotKit sends them, trimmed to the parts the
// fixtures look for.
const markdownGuide = `${MARKDOWN_GUIDE}: how to write UI surfaces inside \`\`\`a2ui code fences.\nYou can show interactive UI in your reply.`;
const markdownSchema = `Generative UI component schema: {"components":{"Slider":{"description":"${CATALOG_EVIDENCE} Give it a label."}}}`;
const toolGuide = `${TOOL_GUIDE}: available components, functions, targets, and how to call render_ui.\n## Generative UI\nCall \`render_ui\` to show UI.`;
const toolCatalog = `- **Slider**: ${CATALOG_EVIDENCE} Give it a label.`;

const renderUI = (name = "render_ui"): ToolDefinition => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
});

function request(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): ChatCompletionRequest {
  return { model: "gpt-4o", messages, ...(tools ? { tools } : {}) };
}

const system = (content: string): ChatMessage => ({ role: "system", content });
const user = (content = GENERATIVE_UI_PROMPT): ChatMessage => ({
  role: "user",
  content,
});

async function isFenceReply(input: ChatCompletionRequest) {
  const response = await composedResponse(input);
  return (
    !!response &&
    "content" in response &&
    typeof response.content === "string" &&
    response.content.includes("```a2ui")
  );
}

async function renderUICall(input: ChatCompletionRequest) {
  const response = await composedResponse(input);
  if (!response || !("toolCalls" in response) || !response.toolCalls) {
    return undefined;
  }
  return response.toolCalls.find((call) => call.name.endsWith("render_ui"));
}

test("markdown: the guide and the component schema answer with a fence", async () => {
  assert.equal(
    await isFenceReply(request([system(`${markdownGuide}\n\n${markdownSchema}`), user()])),
    true,
  );
});

test("markdown: without the guide there is no fence", async () => {
  assert.equal(await isFenceReply(request([system(markdownSchema), user()])), false);
});

test("markdown: without the component schema there is no fence", async () => {
  assert.equal(await isFenceReply(request([system(markdownGuide), user()])), false);
});

test("markdown: the context may arrive in any message and as text parts", async () => {
  // A trailing system message after the user's turn (CopilotKit's LangGraph
  // middleware), and content as an array of text parts (Strands).
  const parts: ChatMessage = {
    role: "system",
    content: [
      { type: "text", text: markdownGuide },
      { type: "text", text: markdownSchema },
    ],
  };
  assert.equal(await isFenceReply(request([user(), parts])), true);
  assert.equal(
    await isFenceReply(
      request([user(`${markdownGuide}\n${markdownSchema}\n\n${GENERATIVE_UI_PROMPT}`)]),
    ),
    true,
  );
});

test("tool: the guide with its catalog and the render_ui tool answer with a render_ui call", async () => {
  const call = await renderUICall(
    request([system(`${toolGuide}\n${toolCatalog}`), user()], [renderUI()]),
  );
  assert.ok(call, "Expected a render_ui call");
  const args = JSON.parse(call.arguments) as { target: string; operations: unknown[] };
  assert.equal(args.target, "chat");
  assert.equal(args.operations.length, 2);
});

test("tool: a prefixed render_ui tool keeps its name in the call", async () => {
  const name = "mcp__frontend__render_ui";
  const call = await renderUICall(
    request([system(`${toolGuide}\n${toolCatalog}`), user()], [renderUI(name)]),
  );
  assert.equal(call?.name, name);
});

test("tool: without the guide, the catalog or the tool there is no render_ui call", async () => {
  assert.equal(
    await renderUICall(request([system(toolCatalog), user()], [renderUI()])),
    undefined,
  );
  assert.equal(
    await renderUICall(request([system(toolGuide), user()], [renderUI()])),
    undefined,
  );
  assert.equal(
    await renderUICall(request([system(`${toolGuide}\n${toolCatalog}`), user()])),
    undefined,
  );
});

test("a tool result after render_ui keeps the shared acknowledgment", async () => {
  // CopilotKit ends the run after render_ui, so this turn is not expected;
  // if an agent loops back anyway, the shared tool-result fallback answers.
  const response = await composedResponse(
    request([
      system(`${toolGuide}\n${toolCatalog}`),
      user(),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_render_plan_picker",
            type: "function",
            function: { name: "render_ui", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_render_plan_picker",
        content: JSON.stringify({ status: "rendered", applied: 2 }),
      },
    ]),
  );
  assert.ok(response && "content" in response);
  assert.equal(response.content, "Done! I've completed that for you.");
});
