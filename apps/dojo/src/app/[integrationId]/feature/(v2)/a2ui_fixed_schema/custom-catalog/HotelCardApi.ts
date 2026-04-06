import { z } from "zod";
import { DynamicStringSchema, DynamicNumberSchema, AccessibilityAttributesSchema, ActionSchema } from "@a2ui/web_core/v0_9";

const CommonProps = {
  accessibility: AccessibilityAttributesSchema.optional(),
  weight: z.number().optional(),
};

export const HotelCardApi = {
  name: "HotelCard" as const,
  schema: z.object({
    ...CommonProps,
    name: DynamicStringSchema,
    location: DynamicStringSchema,
    rating: DynamicNumberSchema,
    price: DynamicStringSchema,
    action: ActionSchema,
  }),
};
