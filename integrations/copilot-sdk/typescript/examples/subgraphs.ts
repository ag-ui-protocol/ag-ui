import type { CopilotClientPort, ToolContext } from "../dist/index.js";
import { defineAgent } from "./base.js";

type Specialist = "flights" | "hotels" | "experiences";
const catalog: Record<Specialist, Record<string, string>[]> = {
  flights: [
    { airline: "KLM", departure: "Amsterdam (AMS)", arrival: "San Francisco (SFO)", price: "$650", duration: "11h 30m" },
    { airline: "United", departure: "Amsterdam (AMS)", arrival: "San Francisco (SFO)", price: "$720", duration: "12h 15m" },
  ],
  hotels: [
    { name: "Hotel Zephyr", location: "Fisherman's Wharf", price_per_night: "$280/night", rating: "4.2 stars" },
    { name: "The Ritz-Carlton", location: "Nob Hill", price_per_night: "$550/night", rating: "4.8 stars" },
    { name: "Hotel Zoe", location: "Union Square", price_per_night: "$320/night", rating: "4.4 stars" },
  ],
  experiences: [
    { name: "Pier 39", type: "activity", description: "Waterfront shops and sea lions", location: "Fisherman's Wharf" },
    { name: "Golden Gate Bridge", type: "activity", description: "Walk across the iconic suspension bridge", location: "Golden Gate" },
    { name: "Swan Oyster Depot", type: "restaurant", description: "Fresh oysters at a historic seafood counter", location: "Polk Street" },
    { name: "Tartine Bakery", type: "restaurant", description: "Artisanal bread and pastries", location: "Mission District" },
  ],
};
const optionSchema = { type: "object", additionalProperties: { type: "string" } };

function travelState({ agent, selection }: { agent: Specialist; selection?: string }, ctx: ToolContext) {
  if (!Object.hasOwn(catalog, agent)) throw new Error("Unknown travel specialist");
  const options = catalog[agent];
  const state = (ctx.state ?? {}) as { itinerary?: Record<string, unknown> };
  const itinerary = { ...state.itinerary };
  if (selection !== undefined) {
    const choice = options.find((option) => (option.airline ?? option.name) === selection);
    if (!choice || agent === "experiences") throw new Error("Choose an offered flight or hotel");
    itinerary[agent === "flights" ? "flight" : "hotel"] = choice;
  }
  ctx.setState({ ...state, itinerary, [agent]: options, active_agent: agent,
    planning_step: agent === "experiences" ? "complete" : agent });
  return JSON.stringify(selection !== undefined ? { agent, selection, saved: true }
    : agent === "experiences" ? { agent, experiences: options }
    : { agent, message: `Choose from these ${agent} for the Amsterdam–San Francisco demo (no booking).`,
        options, recommendation: options[agent === "flights" ? 0 : 2] });
}

function resumeChoice(payload: unknown, args: unknown) {
  const { agent } = args as { agent: Specialist };
  const answer = typeof payload === "string" ? JSON.parse(payload) : payload;
  const key = agent === "flights" ? "airline" : "name";
  if (!["flights", "hotels"].includes(agent) || !answer || typeof answer !== "object"
    || !catalog[agent].some((option) => option[key] === (answer as Record<string, unknown>)[key])) {
    throw new Error("Choose an offered flight or hotel");
  }
  return { agent, selection: (answer as Record<string, unknown>)[key] };
}

/** Native task calls own the subagent lifecycle; tools only publish travel state. */
export const createSubgraphsAgent = (client: CopilotClientPort) => defineAgent(client, {
  agentId: "subgraphs",
  description: "Travel supervisor with flight, hotel, and experience specialists",
  instructions: `You are the Copilot SDK travel supervisor. This is a static Amsterdam–San Francisco demo, not a booking service.
For a travel request, delegate sequentially using the native task tool to flights_agent, then hotels_agent, then experiences_agent.
Each task MUST use agent_type, a short name, description, prompt, and mode="sync". Wait for each task to finish before starting the next.
Never choose flights or hotels yourself or call their tools directly. Relay the final itinerary briefly; nothing is booked.`,
  tools: [
    { name: "travel_state", skipPermission: true, description: "Find demo options, or save the user's selection by airline/hotel name.",
      parameters: { type: "object", properties: { agent: { type: "string", enum: Object.keys(catalog) },
        selection: { type: "string" } }, required: ["agent"] }, handler: travelState },
    { name: "choose_travel_option", description: "Pause for the user to select a flight or hotel. Copy the search result unchanged.",
      parameters: { type: "object", properties: { agent: { type: "string", enum: ["flights", "hotels"] },
        message: { type: "string" }, options: { type: "array", items: optionSchema }, recommendation: optionSchema },
        required: ["agent", "message", "options", "recommendation"] } },
  ],
  interrupts: { choose_travel_option: resumeChoice },
  sessionConfig: { customAgents: (Object.keys(catalog) as Specialist[]).map((agent) => ({
    name: `${agent}_agent`, displayName: `${agent.charAt(0).toUpperCase()}${agent.slice(1)} Agent`,
    description: `Handles ${agent} for the travel itinerary.`,
    tools: agent === "experiences" ? ["travel_state"] : ["travel_state", "choose_travel_option"],
    prompt: `You are the Copilot SDK travel specialist: ${agent}.
First call travel_state with agent="${agent}" and no selection.
${agent === "experiences" ? "Summarize the returned activities and restaurants." : `Call choose_travel_option with the entire returned JSON unchanged.
Wait for the user's decision. Then call travel_state with agent="${agent}" and exactly the selection returned by the interrupt.
Only after saving, confirm the selection. Never choose on behalf of the user.`}
These are static demo options, not real bookings.`,
  })) },
});
