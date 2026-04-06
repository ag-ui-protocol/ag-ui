import { z } from "zod";
import { ChildListSchema, AccessibilityAttributesSchema } from "@a2ui/web_core/v0_9";

const CommonProps = {
  accessibility: AccessibilityAttributesSchema.optional(),
  weight: z.number().optional(),
};

export const RowApi = {
  name: "Row" as const,
  schema: z.object({
    ...CommonProps,
    gap: z.number().optional(),
    align: z.string().optional(),
    justify: z.string().optional(),
    children: ChildListSchema,
  }),
};
