/**
 * Shared A2UI Catalog — Component APIs
 *
 * All custom components used across dojo demos (fixed schema, dynamic schema, advanced).
 * Components: Row, FlightCard, HotelCard, ProductCard, TeamMemberCard, StarRating
 */
import { z } from "zod";
import {
  DynamicStringSchema,
  DynamicNumberSchema,
  AccessibilityAttributesSchema,
  ActionSchema,
  ChildListSchema,
} from "@a2ui/web_core/v0_9";

const CommonProps = {
  accessibility: AccessibilityAttributesSchema.optional(),
  weight: z.number().optional(),
};

export const RowApi = {
  name: "Row" as const,
  schema: z.object({
    ...CommonProps,
    gap: z.number().optional(),
    children: ChildListSchema,
  }),
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

export const HotelCardApi = {
  name: "HotelCard" as const,
  schema: z.object({
    ...CommonProps,
    name: DynamicStringSchema,
    location: DynamicStringSchema,
    rating: DynamicNumberSchema,
    pricePerNight: DynamicStringSchema,
    amenities: DynamicStringSchema.optional(),
    action: ActionSchema,
  }),
};

export const ProductCardApi = {
  name: "ProductCard" as const,
  schema: z.object({
    ...CommonProps,
    name: DynamicStringSchema,
    price: DynamicStringSchema,
    rating: DynamicNumberSchema,
    description: DynamicStringSchema.optional(),
    badge: DynamicStringSchema.optional(),
    action: ActionSchema,
  }),
};

export const TeamMemberCardApi = {
  name: "TeamMemberCard" as const,
  schema: z.object({
    ...CommonProps,
    name: DynamicStringSchema,
    role: DynamicStringSchema,
    department: DynamicStringSchema.optional(),
    email: DynamicStringSchema.optional(),
    avatarUrl: DynamicStringSchema.optional(),
    action: ActionSchema,
  }),
};

export const StarRatingApi = {
  name: "StarRating" as const,
  schema: z.object({
    ...CommonProps,
    value: DynamicNumberSchema.describe("Rating value from 0 to maxStars"),
    maxStars: z.number().default(5).optional(),
    label: DynamicStringSchema.optional(),
  }),
};
