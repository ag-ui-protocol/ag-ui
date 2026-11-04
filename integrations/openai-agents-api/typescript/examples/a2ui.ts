/**
 * A2UI with fixed, pre-authored schemas: the backend tools return an
 * `a2ui_operations` envelope, and the runtime's A2UI middleware paints it.
 */

import {
  A2UI_OPERATIONS_KEY,
  createSurface,
  updateComponents,
  updateDataModel,
} from "@ag-ui/a2ui-toolkit";
import type { BackendTool } from "../src";

const FIXED_CATALOG_ID = "https://a2ui.org/demos/dojo/fixed_catalog.json";

const FLIGHT_SCHEMA: Array<Record<string, unknown>> = [
  {
    id: "root",
    component: "Row",
    children: { componentId: "flight-card", path: "/flights" },
    gap: 16,
  },
  {
    id: "flight-card",
    component: "FlightCard",
    airline: { path: "airline" },
    airlineLogo: { path: "airlineLogo" },
    flightNumber: { path: "flightNumber" },
    origin: { path: "origin" },
    destination: { path: "destination" },
    date: { path: "date" },
    departureTime: { path: "departureTime" },
    arrivalTime: { path: "arrivalTime" },
    duration: { path: "duration" },
    status: { path: "status" },
    price: { path: "price" },
    action: {
      event: {
        name: "book_flight",
        context: {
          flightNumber: { path: "flightNumber" },
          origin: { path: "origin" },
          destination: { path: "destination" },
          price: { path: "price" },
        },
      },
    },
  },
];

const HOTEL_SCHEMA: Array<Record<string, unknown>> = [
  {
    id: "root",
    component: "Row",
    children: { componentId: "hotel-card", path: "/hotels" },
    gap: 16,
  },
  {
    id: "hotel-card",
    component: "HotelCard",
    name: { path: "name" },
    location: { path: "location" },
    rating: { path: "rating" },
    pricePerNight: { path: "price" },
    action: {
      event: {
        name: "book_hotel",
        context: { hotelName: { path: "name" }, price: { path: "price" } },
      },
    },
  },
];

const envelope = (
  surfaceId: string,
  schema: Array<Record<string, unknown>>,
  data: Record<string, unknown>,
) => ({
  [A2UI_OPERATIONS_KEY]: [
    createSurface(surfaceId, FIXED_CATALOG_ID),
    updateComponents(surfaceId, schema),
    updateDataModel(surfaceId, data),
  ],
});

const objectList = (description: string) => ({
  type: "array",
  description,
  items: { type: "object", additionalProperties: true },
});

export const a2uiFixedSchemaTools: BackendTool[] = [
  {
    name: "search_flights",
    description: "Search for flights and display the results as rich cards.",
    parameters: {
      type: "object",
      properties: {
        flights: objectList(
          "Flights, each with id, airline, airlineLogo, flightNumber, origin, destination, date, departureTime, arrivalTime, duration, status and price.",
        ),
      },
      required: ["flights"],
    },
    handler: ({ flights }: { flights: unknown[] }) =>
      envelope("flight-search-results", FLIGHT_SCHEMA, { flights }),
  },
  {
    name: "search_hotels",
    description:
      "Search for hotels and display the results as rich cards with star ratings.",
    parameters: {
      type: "object",
      properties: {
        hotels: objectList(
          "Hotels, each with id, name, location, rating (0-5) and price per night.",
        ),
      },
      required: ["hotels"],
    },
    handler: ({ hotels }: { hotels: unknown[] }) =>
      envelope("hotel-search-results", HOTEL_SCHEMA, { hotels }),
  },
];
