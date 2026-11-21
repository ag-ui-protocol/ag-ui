/**
 * aimock fixtures for the A2A middleware demo (middlewares/a2a-middleware).
 *
 * One delegation round trip, three model calls:
 *   1) The orchestrator (ADK on Gemini) gets the user's request and calls
 *      send_message_to_a2a_agent for the Finance Agent.
 *   2) The middleware sends that task over A2A to the Finance Agent, whose
 *      server asks its own model (gpt-4o) for the reply.
 *   3) The middleware hands the reply back as the tool result and reruns the
 *      orchestrator, which reports what the department said.
 *
 * The orchestrator is the only agent offered send_message_to_a2a_agent, and the
 * Finance Agent is scoped by a phrase from its own instructions, so these
 * fixtures cannot answer another integration's turns.
 *
 * Register via `registerA2AMiddlewareFixtures(mockServer)` from aimock-setup.ts,
 * before the generic fixture-file loader.
 */
import type { ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { textOf } from "./lib/fixture-message-text";

/** The user's request in a2aMiddlewareTests; the spec sends this text. */
export const A2A_DELEGATION_PROMPT = "Please set up payroll for our new hire Jane Doe";
/** The task the orchestrator delegates; the Finance fixture matches on it. */
export const A2A_FINANCE_TASK = "Set up payroll for new hire Jane Doe.";
/** The Finance Agent's reply. Its id only exists here, so a spec that sees it
 * knows the reply really came back over A2A. */
export const A2A_FINANCE_REPLY = "Payroll for Jane Doe is set up under employee id FIN-4242.";

const DELEGATE_TOOL = "send_message_to_a2a_agent";
const FINANCE_INSTRUCTIONS = /simulating an agent in the finance department/i;

const hasTool = (request: ChatCompletionRequest, name: string): boolean =>
  !!request.tools?.some((t) => t.function.name === name);

const lastMessage = (request: ChatCompletionRequest) =>
  request.messages[request.messages.length - 1];

const lastUserText = (request: ChatCompletionRequest): string =>
  textOf(request.messages.filter((m) => m.role === "user").pop()?.content);

// The department agents send their instructions as a developer message. aimock
// passes that role through although its ChatMessage type does not list it.
const instructionText = (request: ChatCompletionRequest): string =>
  request.messages
    .filter((m) => m.role === "system" || (m.role as string) === "developer")
    .map((m) => textOf(m.content))
    .join("\n");

const isOrchestrator = (request: ChatCompletionRequest): boolean =>
  hasTool(request, DELEGATE_TOOL);

/** True for the orchestrator's turn after a delegated task came back. */
export function isA2AMiddlewareToolResultTurn(request: ChatCompletionRequest): boolean {
  return isOrchestrator(request) && lastMessage(request)?.role === "tool";
}

export function registerA2AMiddlewareFixtures(mockServer: LLMock): void {
  // 1) Orchestrator: delegate the payroll task to the Finance Agent.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: (request) =>
        isOrchestrator(request) &&
        lastMessage(request)?.role === "user" &&
        lastUserText(request).includes(A2A_DELEGATION_PROMPT),
    },
    response: {
      toolCalls: [
        {
          name: DELEGATE_TOOL,
          arguments: JSON.stringify({
            agentName: "Finance Agent",
            task: A2A_FINANCE_TASK,
          }),
        },
      ],
    },
  });

  // 2) Finance Agent: answer the delegated task.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: (request) =>
        FINANCE_INSTRUCTIONS.test(instructionText(request)) &&
        lastUserText(request).includes(A2A_FINANCE_TASK),
    },
    response: { content: A2A_FINANCE_REPLY },
  });

  // 3) Orchestrator: relay what the department said. Read from the tool result,
  //    so a fabricated reply could not pass for the one that came back.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: (request) => isA2AMiddlewareToolResultTurn(request),
    },
    response: (request: ChatCompletionRequest) => ({
      content: `The Finance Agent replied: ${textOf(lastMessage(request)?.content)}`,
    }),
  });
}
