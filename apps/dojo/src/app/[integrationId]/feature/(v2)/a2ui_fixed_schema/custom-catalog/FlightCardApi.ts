import { z } from "zod";
import { DynamicStringSchema, AccessibilityAttributesSchema, ActionSchema } from "@a2ui/web_core/v0_9";

const CommonProps = {
  accessibility: AccessibilityAttributesSchema.optional(),
  weight: z.number().optional(),
};

export const FlightCardApi = {
  name: "FlightCard" as const,
  schema: z.object({
    ...CommonProps,
    airline: DynamicStringSchema,
    airlineLogo: DynamicStringSchema,
    flightNumber: DynamicStringSchema,
    origin: DynamicStringSchema,
    destination: DynamicStringSchema,
    date: DynamicStringSchema,
    departureTime: DynamicStringSchema,
    arrivalTime: DynamicStringSchema,
    duration: DynamicStringSchema,
    status: DynamicStringSchema,
    price: DynamicStringSchema,
    action: ActionSchema,
  }),
};
