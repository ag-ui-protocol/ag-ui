/**
 * aimock fixtures for the Google ADK interrupt demo.
 *
 * `schedule_meeting` is a backend tool that pauses ITSELF by asking for a tool
 * confirmation. Two model calls bracket the pause: the one that proposes the
 * call, and the one that reacts to the re-run tool's result once the user has
 * picked a time or cancelled. The responses differ by where in the flow the
 * call happens rather than by the user's text, so they need predicates.
 *
 * Scoped to Gemini requests carrying a line only this demo's instruction has.
 * The Strands and Mastra interrupt demos drive a tool of the same name through
 * the same page, so matching on the tool name would claim their turns too.
 *
 * Register via `registerInterruptADKFixtures(mockServer)` from aimock-setup.ts,
 * before the generic fixture-file loader.
 */
import type {
  LLMock,
  ChatMessage,
  ChatCompletionRequest,
} from "@copilotkit/aimock";
import { textOf } from "./lib/fixture-message-text";

const systemText = (messages: ChatMessage[] = []): string =>
  messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n");

const lastUserText = (messages: ChatMessage[] = []): string =>
  textOf(messages.filter((m) => m.role === "user").pop()?.content);

const IS_ADK_INTERRUPT = (req: ChatCompletionRequest) =>
  /gemini/i.test(String(req?.model ?? "")) &&
  /Only report a meeting as booked when the schedule_meeting result says so/i.test(
    systemText(req.messages),
  );

/** True when the model is reacting to a tool result rather than a user turn. */
const awaitingToolReaction = (messages: ChatMessage[] = []): boolean =>
  messages[messages.length - 1]?.role === "tool";

/**
 * What the re-run tool returned, as plain text.
 *
 * ADK wraps a non-dict tool return as `{"result": ...}`, and aimock serializes
 * the Gemini function response as JSON, so the string is unwrapped here.
 */
const scheduleResult = (messages: ChatMessage[] = []): string => {
  const raw = textOf(messages[messages.length - 1]?.content);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { result?: unknown }).result === "string"
    ) {
      return (parsed as { result: string }).result;
    }
  } catch {
    // Not JSON: already the tool's own text.
  }
  return raw;
};

/**
 * The reply for an ADK interrupt tool-result turn, or `null` if this file has
 * none. The fixture below and the veto in aimock-setup.ts both read this, so
 * they cannot disagree about which turns this file answers.
 */
function adkInterruptToolResultReply(
  req: ChatCompletionRequest,
): string | null {
  if (!IS_ADK_INTERRUPT(req) || !awaitingToolReaction(req.messages)) {
    return null;
  }
  const result = scheduleResult(req.messages);
  // Reading the tool's own words: the chosen time only exists in the result, so
  // a canned reply could not carry it and a spec could not tell a resumed run
  // from a fabricated one.
  const scheduled = /^Meeting scheduled for (.+): /.exec(result);
  if (scheduled) {
    return `Your meeting is scheduled for ${scheduled[1]}. Looking forward to it!`;
  }
  if (/cancelled/i.test(result)) {
    return "No problem, I did not schedule anything. Tell me what you would like instead.";
  }
  return "I have left your calendar untouched. Tell me what you would like instead.";
}

/** True for a tool-result turn this file answers itself. */
export function adkInterruptAnswersToolResultTurn(
  req: ChatCompletionRequest,
): boolean {
  return adkInterruptToolResultReply(req) !== null;
}

export function registerInterruptADKFixtures(mockServer: LLMock): void {
  // The page's second suggestion pill. Registered ahead of the default booking
  // so clicking it proposes the meeting it actually names.
  mockServer.addFixture({
    match: {
      predicate: (req) =>
        IS_ADK_INTERRUPT(req) &&
        !awaitingToolReaction(req.messages) &&
        /1:1 with Alice/i.test(lastUserText(req.messages)),
    },
    response: {
      toolCalls: [
        {
          name: "schedule_meeting",
          arguments: JSON.stringify({
            topic: "1:1 to review Q2 goals",
            attendee: "Alice",
          }),
          id: "call_schedule_meeting_alice",
        },
      ],
    },
  });

  // Propose the meeting. Gemini tool-call ids are supplied explicitly: without
  // one ADK mints a fresh id per SSE event (see a2ui-adk-fixtures.ts).
  mockServer.addFixture({
    match: {
      predicate: (req) =>
        IS_ADK_INTERRUPT(req) && !awaitingToolReaction(req.messages),
    },
    response: {
      toolCalls: [
        {
          name: "schedule_meeting",
          arguments: JSON.stringify({
            topic: "Intro call to discuss pricing",
            attendee: "the sales team",
          }),
          id: "call_schedule_meeting_1",
        },
      ],
    },
  });

  // React to the re-run tool's result.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: (req) => adkInterruptToolResultReply(req) !== null,
    },
    response: (req) => ({ content: adkInterruptToolResultReply(req)! }),
  });
}
