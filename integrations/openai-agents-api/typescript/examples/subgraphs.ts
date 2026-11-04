/**
 * Subgraphs: a travel supervisor delegating to flights, hotels and experiences
 * specialists. Each specialist is a backend tool that publishes what it is doing
 * through shared state, and (for flights and hotels) pauses on the user with an
 * interrupt so they can pick an option.
 *
 * The page's interrupt card reads `message`, `options`, `recommendation` and
 * `agent` from the interrupt's metadata and resolves with the chosen option as
 * a JSON string.
 */

import type { BackendTool, BackendToolContext } from "../src";

type Option = Record<string, string>;

const FLIGHTS: Option[] = [
  {
    airline: "KLM",
    departure: "Amsterdam (AMS)",
    arrival: "San Francisco (SFO)",
    price: "$650",
    duration: "11h 30m",
  },
  {
    airline: "United",
    departure: "Amsterdam (AMS)",
    arrival: "San Francisco (SFO)",
    price: "$720",
    duration: "12h 15m",
  },
];

const HOTELS: Option[] = [
  {
    name: "Hotel Zephyr",
    location: "Fisherman's Wharf",
    price_per_night: "$280/night",
    rating: "4.2 stars",
  },
  {
    name: "The Ritz-Carlton",
    location: "Nob Hill",
    price_per_night: "$550/night",
    rating: "4.8 stars",
  },
  {
    name: "Hotel Zoe",
    location: "Union Square",
    price_per_night: "$320/night",
    rating: "4.4 stars",
  },
];

const EXPERIENCES: Option[] = [
  {
    name: "Swan Oyster Depot",
    type: "restaurant",
    description: "Historic seafood counter serving fresh oysters",
    location: "Polk Street",
  },
  {
    name: "Tartine Bakery",
    type: "restaurant",
    description: "Artisanal bakery famous for bread and pastries",
    location: "Mission District",
  },
  {
    name: "Pier 39",
    type: "activity",
    description: "Iconic waterfront destination with shops and sea lions",
    location: "Fisherman's Wharf",
  },
  {
    name: "Golden Gate Bridge",
    type: "activity",
    description: "World-famous suspension bridge with stunning views",
    location: "Golden Gate",
  },
];

const update = (
  context: BackendToolContext,
  changes: Record<string, unknown>,
) => {
  const state = { ...(context.state as Record<string, unknown>), ...changes };
  context.setState(state);
  return state;
};

const setItinerary = (
  context: BackendToolContext,
  key: string,
  value: Option,
) => {
  const state = context.state as Record<string, unknown>;
  update(context, {
    itinerary: {
      ...((state.itinerary as Record<string, unknown>) ?? {}),
      [key]: value,
    },
  });
};

/** The option the page sent back, matched against the offered ones. */
const chosenOption = (
  payload: unknown,
  options: Option[],
  key: string,
): Option | undefined => {
  let answer = payload;
  if (typeof answer === "string") {
    try {
      answer = JSON.parse(answer);
    } catch {
      return undefined;
    }
  }
  if (!answer || typeof answer !== "object") return undefined;
  return options.find((option) => option[key] === (answer as Option)[key]);
};

export const subgraphTools: BackendTool[] = [
  {
    name: "flights_agent",
    description:
      "The flights specialist: finds flights and has the user pick one.",
    parameters: {
      type: "object",
      properties: {
        origin: {
          type: "string",
          description: 'Where the trip starts, e.g. "Amsterdam"',
        },
        destination: {
          type: "string",
          description: 'Where the trip goes, e.g. "San Francisco"',
        },
      },
      required: ["origin", "destination"],
    },
    handler: (
      { origin, destination }: { origin: string; destination: string },
      context,
    ) => {
      if (!context.resume) {
        update(context, { active_agent: "flights", planning_step: "flights" });
        const recommendation = FLIGHTS[0];
        context.interrupt({
          reason: "flights",
          message: `Found ${FLIGHTS.length} flight options from ${origin} to ${destination}. I recommend choosing the flight by ${recommendation.airline} since it's known to be on time and cheaper.`,
          metadata: { options: FLIGHTS, recommendation, agent: "flights" },
        });
      }
      const chosen =
        context.resume!.status === "resolved"
          ? chosenOption(context.resume!.payload, FLIGHTS, "airline")
          : undefined;
      if (!chosen)
        return "Flights Agent: No flight was chosen, so none is booked.";
      update(context, { flights: FLIGHTS, active_agent: "supervisor" });
      setItinerary(context, "flight", chosen);
      return `Flights Agent: Great. I'll book you the ${chosen.airline} flight from ${chosen.departure} to ${chosen.arrival}.`;
    },
  },
  {
    name: "hotels_agent",
    description:
      "The hotels specialist: finds hotels and has the user pick one.",
    parameters: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description: 'The city to stay in, e.g. "San Francisco"',
        },
      },
      required: ["destination"],
    },
    handler: ({ destination }: { destination: string }, context) => {
      if (!context.resume) {
        update(context, { active_agent: "hotels", planning_step: "hotels" });
        const recommendation = HOTELS[2];
        context.interrupt({
          reason: "hotels",
          message: `Found ${HOTELS.length} accommodation options in ${destination}. I recommend choosing the ${recommendation.name} since it strikes the balance between rating, price, and location.`,
          metadata: { options: HOTELS, recommendation, agent: "hotels" },
        });
      }
      const chosen =
        context.resume!.status === "resolved"
          ? chosenOption(context.resume!.payload, HOTELS, "name")
          : undefined;
      if (!chosen)
        return "Hotels Agent: No hotel was chosen, so none is booked.";
      update(context, { hotels: HOTELS, active_agent: "supervisor" });
      setItinerary(context, "hotel", chosen);
      return `Hotels Agent: Excellent choice! You'll like ${chosen.name}.`;
    },
  },
  {
    name: "experiences_agent",
    description:
      "The experiences specialist: finds restaurants and activities.",
    parameters: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description: 'The city, e.g. "San Francisco"',
        },
      },
      required: ["destination"],
    },
    handler: ({ destination }: { destination: string }, context) => {
      update(context, {
        active_agent: "experiences",
        planning_step: "experiences",
      });
      update(context, {
        experiences: EXPERIENCES,
        active_agent: "supervisor",
        planning_step: "complete",
      });
      return {
        destination,
        experiences: EXPERIENCES,
        note: "Experiences Agent: These are planned. Summarize them for the user.",
      };
    },
  },
];
