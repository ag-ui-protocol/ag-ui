/**
 * Dynamic Catalog — Pre-made domain components + Row layout
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
