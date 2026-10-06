/**
 * aimock fixtures for the Google Antigravity A2UI dojo demos.
 *
 * Two kinds of request reach aimock for these demos, both under the
 * `X-AIMock-Context: antigravity` header:
 *
 * - The harness' own turns (the "outer" requests). The harness never sends a
 *   `role: "tool"` message, so each leg is staged on `turnIndex` (assistant
 *   messages so far: +2 per tool round trip, +1 per text answer; the highest
 *   `turnIndex` not above the count wins), as in antigravity-fixtures.ts. Each
 *   outer leg also names the demo's own tool (`toolName`), so it only answers
 *   the agent that owns it.
 * - The sub-agent call `generate_a2ui` makes itself (the "inner" request):
 *   a single user turn carrying the request, `render_a2ui` as its only tool,
 *   and the toolkit's prompt as the system instruction. `toolName:
 *   "render_a2ui"` keeps these apart from the outer requests, which never
 *   carry that tool, and the toolkit's retry marker in the system instruction
 *   tells a retry from a first attempt.
 *
 * The inner `render_a2ui` arguments are Gemini-shaped: `components` and `data`
 * are JSON strings, as the example's function declaration asks for.
 *
 * Register these before every shared fixture (right after
 * registerAntigravityFixtures): several shared predicate fixtures match the
 * same requests (any request offering `generate_a2ui`, any Gemini request
 * offering `search_flights`), and among fallbacks registration order decides.
 */
import type { LLMock } from "@copilotkit/aimock";

const CONTEXT = "antigravity";

// Toolkit appends this on a retry (augment_prompt_with_validation_errors).
const RETRY_MARKER = "Previous attempt was invalid";

type ToolCallResponse = {
  toolCalls: { name: string; arguments: string; id: string }[];
};

const toolCall = (
  name: string,
  args: Record<string, unknown>,
  id: string,
): ToolCallResponse => ({
  toolCalls: [{ name, arguments: JSON.stringify(args), id }],
});

/**
 * An outer tool leg at `at` and its closing text two assistant messages later,
 * both scoped to the agent that offers `toolName`.
 */
function toolThenText(
  mockServer: LLMock,
  userMessage: string,
  toolName: string,
  toolResponse: ToolCallResponse,
  text: string,
  at: number,
): void {
  mockServer.addFixture({
    match: { userMessage, toolName, turnIndex: at, context: CONTEXT },
    response: toolResponse,
  });
  mockServer.addFixture({
    match: { userMessage, toolName, turnIndex: at + 2, context: CONTEXT },
    response: { content: text },
  });
}

// --- fixed schema ---------------------------------------------------------

// Same rows the ADK fixed-schema fixtures use, so both integrations render
// the same cards.
const FLIGHTS = [
  {
    id: "1",
    airline: "United Airlines",
    airlineLogo: "https://www.google.com/s2/favicons?domain=united.com&sz=128",
    flightNumber: "UA 123",
    origin: "SFO",
    destination: "JFK",
    date: "Tue, Apr 8",
    departureTime: "8:00 AM",
    arrivalTime: "4:30 PM",
    duration: "5h 30m",
    status: "On Time",
    statusIcon: "https://placehold.co/12/22c55e/22c55e.png",
    price: "$289",
  },
  {
    id: "2",
    airline: "Delta",
    airlineLogo: "https://www.google.com/s2/favicons?domain=delta.com&sz=128",
    flightNumber: "DL 456",
    origin: "SFO",
    destination: "JFK",
    date: "Tue, Apr 8",
    departureTime: "10:00 AM",
    arrivalTime: "6:45 PM",
    duration: "5h 45m",
    status: "On Time",
    statusIcon: "https://placehold.co/12/22c55e/22c55e.png",
    price: "$315",
  },
];
const HOTELS_FIXED = [
  {
    id: "1",
    name: "The Manhattan Grand",
    location: "Downtown Manhattan",
    rating: 4.5,
    price: "$350",
  },
  {
    id: "2",
    name: "Downtown Boutique Hotel",
    location: "SoHo",
    rating: 4.0,
    price: "$280",
  },
];

// --- dynamic schema / advanced / recovery ---------------------------------

const HOTEL_ROOT = {
  id: "root",
  component: "Row",
  children: { componentId: "card", path: "/items" },
  gap: 16,
};
const HOTEL_CARD = {
  id: "card",
  component: "HotelCard",
  name: { path: "name" },
  location: { path: "location" },
  rating: { path: "rating" },
  pricePerNight: { path: "price" },
  action: {
    event: { name: "book_hotel", context: { hotelName: { path: "name" } } },
  },
};
const HOTELS = [
  { name: "The Ritz", location: "Paris", rating: 4.8, price: "$450/night" },
  { name: "Holiday Inn", location: "Austin", rating: 4.1, price: "$180/night" },
  {
    name: "Boutique Loft",
    location: "Lisbon",
    rating: 4.6,
    price: "$320/night",
  },
];

/**
 * The hotel surface. The invalid form drops the `card` template the root's
 * repeated child refers to, a structural "unresolved child" error.
 */
const hotelRender = (valid: boolean, id: string): ToolCallResponse =>
  toolCall(
    "render_a2ui",
    {
      surfaceId: "hotel-comparison",
      components: JSON.stringify(
        valid ? [HOTEL_ROOT, HOTEL_CARD] : [HOTEL_ROOT],
      ),
      data: JSON.stringify({ items: HOTELS }),
    },
    id,
  );

const TEAM_ROOT = {
  id: "root",
  component: "Row",
  children: { componentId: "card", path: "/items" },
};
const TEAM_CARD = {
  id: "card",
  component: "TeamMemberCard",
  name: { path: "name" },
  role: { path: "role" },
  department: { path: "department" },
  email: { path: "email" },
  action: { event: { name: "contact", context: { name: { path: "name" } } } },
};
const TEAM = [
  {
    name: "Alice Chen",
    role: "Engineering Lead",
    department: "Engineering",
    email: "alice@example.com",
  },
  {
    name: "Bob Martinez",
    role: "Product Designer",
    department: "Design",
    email: "bob@example.com",
  },
  {
    name: "Carol Davis",
    role: "Backend Engineer",
    department: "Engineering",
    email: "carol@example.com",
  },
  {
    name: "Dan Wilson",
    role: "DevOps Engineer",
    department: "Infrastructure",
    email: "dan@example.com",
  },
];

/** The outer generate_a2ui leg and its text, plus the inner render answer. */
function generated(
  mockServer: LLMock,
  userMessage: string,
  slug: string,
  text: string,
): void {
  toolThenText(
    mockServer,
    userMessage,
    "generate_a2ui",
    // The request is the matched phrase, so the inner request carries it too.
    toolCall(
      "generate_a2ui",
      { request: userMessage },
      `call_antigravity_${slug}_outer`,
    ),
    text,
    0,
  );
}

function inner(
  mockServer: LLMock,
  userMessage: string,
  response: ToolCallResponse,
  retry?: boolean,
): void {
  mockServer.addFixture({
    match: {
      userMessage,
      toolName: "render_a2ui",
      ...(retry ? { systemMessage: RETRY_MARKER } : {}),
      context: CONTEXT,
    },
    response,
  });
}

// Prompts, as the specs and page pills send them (substring match).
export const ANTIGRAVITY_A2UI_PROMPTS = {
  flights: "flights from SFO to JFK",
  hotels: "hotels in downtown Manhattan",
  hotelComparison: "comparison of 3 hotels",
  teamDirectory: "team directory with 4 people",
  recover: "3 luxury hotels with ratings",
  exhaust: "3 broken hotels",
  thanks: "Thanks anyway",
} as const;

export function registerAntigravityA2UIFixtures(mockServer: LLMock): void {
  const p = ANTIGRAVITY_A2UI_PROMPTS;

  // Fixed schema. Flights on a fresh thread (0/2); hotels either on a fresh
  // thread (0/2) or after the flights (3/5), as the multi-surface spec does.
  toolThenText(
    mockServer,
    p.flights,
    "search_flights",
    toolCall("search_flights", { flights: FLIGHTS }, "call_antigravity_flights"),
    "Here are some flights from SFO to JFK — want me to book one?",
    0,
  );
  for (const at of [0, 3]) {
    toolThenText(
      mockServer,
      p.hotels,
      "search_hotels",
      toolCall(
        "search_hotels",
        { hotels: HOTELS_FIXED },
        `call_antigravity_hotels_${at}`,
      ),
      "Here are some hotels in downtown Manhattan — want me to book one?",
      at,
    );
  }

  // Inner sub-agent requests. The retry fixture comes first: a retry prompt
  // also satisfies the first-attempt fixture, and registration order decides.
  inner(
    mockServer,
    p.recover,
    hotelRender(true, "call_antigravity_recover_retry"),
    true,
  );
  inner(mockServer, p.recover, hotelRender(false, "call_antigravity_recover_first"));
  inner(mockServer, p.exhaust, hotelRender(false, "call_antigravity_exhaust"));
  inner(
    mockServer,
    p.hotelComparison,
    hotelRender(true, "call_antigravity_hotel_comparison"),
  );
  inner(
    mockServer,
    p.teamDirectory,
    toolCall(
      "render_a2ui",
      {
        surfaceId: "team-roster",
        components: JSON.stringify([TEAM_ROOT, TEAM_CARD]),
        data: JSON.stringify({ items: TEAM }),
      },
      "call_antigravity_team_directory",
    ),
  );

  // Outer legs: dynamic schema and advanced share the hotel and team prompts.
  generated(
    mockServer,
    p.hotelComparison,
    "hotel_comparison",
    "Here's a comparison of three hotels.",
  );
  generated(
    mockServer,
    p.teamDirectory,
    "team_directory",
    "Here's your team directory.",
  );
  generated(
    mockServer,
    p.recover,
    "recover",
    "The first draft was malformed, so I repaired it — here are three luxury hotels.",
  );
  generated(
    mockServer,
    p.exhaust,
    "exhaust",
    "Sorry, I couldn't generate that UI.",
  );

  // The recovery specs check that the chat still answers after a hard failure.
  mockServer.addFixture({
    match: {
      userMessage: p.thanks,
      toolName: "generate_a2ui",
      turnIndex: 0,
      context: CONTEXT,
    },
    response: { content: "You're welcome — let me know if you'd like to try again." },
  });
}
