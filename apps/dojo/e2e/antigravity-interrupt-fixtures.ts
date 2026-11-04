/**
 * aimock fixtures for the Google Antigravity `interrupt` and `subgraphs` dojo
 * demos.
 *
 * Same scheme as antigravity-fixtures.ts: the Antigravity harness never sends
 * `role: "tool"`, so each leg is staged on `turnIndex` (assistant messages so
 * far: +2 per tool round trip, +1 per text answer; the highest `turnIndex` not
 * above the count wins), and every fixture is scoped to `context:
 * "antigravity"`, the `X-AIMock-Context` header the example server stamps on
 * its Gemini endpoint.
 *
 * Both demos pause a server tool on an AG-UI interrupt, so one harness turn
 * spans several AG-UI runs: the resumed run's next model request is simply the
 * same turn with two more assistant messages.
 *
 * Each fixture also requires its demo's own tool (`toolName`), so it can only
 * match requests from that demo. That makes it safe to register these FIRST,
 * ahead of registerAntigravityFixtures: its backend-tool-rendering legs match
 * any prompt containing "San Francisco" at turnIndex 0 and 2, and on a tie the
 * earlier fixture wins, so registered after them the travel prompts below
 * would get a `get_weather` call the subgraphs agent does not have (an unknown
 * tool name aborts the run). Ahead of the shared Mastra `schedule_meeting`
 * predicate fixtures too, which carry no turnIndex and would otherwise win at
 * an exact position.
 *
 * What aimock cannot see: the harness sends a tool's result back as a
 * `functionResponse` part in a *model* turn, and aimock's Gemini conversion
 * keeps only `functionCall` and text from model turns. The tool result never
 * reaches a matcher (no `toolResultContains`, no raw body for `predicate`), so
 * a closing text cannot depend on what the user answered. The interrupt demo's
 * cancel journey therefore uses its own prompt (the page's other suggestion),
 * and the spec proves the cancel reached the tool from the tool's own result
 * on the wire, not from this canned reply.
 */
import type { LLMock } from "@copilotkit/aimock";

const CONTEXT = "antigravity";

/** The booking prompt the interrupt spec picks a time for. */
export const ANTIGRAVITY_BOOK_REQUEST =
  "Book an intro call with the sales team to discuss pricing.";
/** The booking prompt the interrupt spec cancels. */
export const ANTIGRAVITY_CANCEL_REQUEST =
  "Schedule a 1:1 with Alice next week to review Q2 goals.";
/**
 * The slot the spec picks: the first one the page offers with its clock fixed
 * at 2026-09-11T09:00Z, rendered in UTC for en-US.
 */
export const ANTIGRAVITY_BOOKED_SLOT = "Sat, Sep 12, 10:00 AM";

/** The two travel prompts the subgraphs spec sends. */
export const ANTIGRAVITY_TRIP_REQUESTS = [
  "Help me plan a trip to San Francisco",
  "I want to visit San Francisco from Amsterdam",
] as const;
export const ANTIGRAVITY_TRIP_SUMMARY =
  "I've found some wonderful experiences for your trip to San Francisco! Your flight and hotel are booked, and the itinerary now lists two restaurants and two activities.";

function toolCall(name: string, args: Record<string, unknown>) {
  return { toolCalls: [{ name, arguments: JSON.stringify(args) }] };
}

function stage(
  mockServer: LLMock,
  userMessage: string,
  toolName: string,
  legs: Record<string, unknown>[],
): void {
  legs.forEach((response, i) => {
    mockServer.addFixture({
      match: { userMessage, toolName, turnIndex: i * 2, context: CONTEXT },
      response,
    });
  });
}

export function registerAntigravityInterruptFixtures(mockServer: LLMock): void {
  // Interrupt: schedule_meeting pauses itself on the picker (0); once the user
  // answers, the resumed turn closes with text (2).
  stage(mockServer, ANTIGRAVITY_BOOK_REQUEST, "schedule_meeting", [
    toolCall("schedule_meeting", {
      topic: "Intro call to discuss pricing",
      attendee: "the sales team",
    }),
    {
      content: `Your meeting is scheduled for ${ANTIGRAVITY_BOOKED_SLOT}. Looking forward to it!`,
    },
  ]);
  stage(mockServer, ANTIGRAVITY_CANCEL_REQUEST, "schedule_meeting", [
    toolCall("schedule_meeting", {
      topic: "1:1 to review Q2 goals",
      attendee: "Alice",
    }),
    {
      content:
        "No problem, I did not schedule anything. Tell me what you would like instead.",
    },
  ]);

  // Subgraphs: the supervisor delegates to flights (0) and hotels (2), each of
  // which pauses for the user's pick, then experiences (4), then sums up (6).
  for (const prompt of ANTIGRAVITY_TRIP_REQUESTS) {
    stage(mockServer, prompt, "flights_agent", [
      toolCall("flights_agent", {
        origin: "Amsterdam",
        destination: "San Francisco",
      }),
      toolCall("hotels_agent", { destination: "San Francisco" }),
      toolCall("experiences_agent", { destination: "San Francisco" }),
      { content: ANTIGRAVITY_TRIP_SUMMARY },
    ]);
  }
}
