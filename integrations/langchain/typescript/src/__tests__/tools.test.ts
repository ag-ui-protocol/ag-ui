import { describe, expect, it } from "vitest";
import { convertAGUIToolToLangChain } from "../tools";

describe("convertAGUIToolToLangChain", () => {
  // Guards against "integer" being rejected as an invalid schema: it is a
  // standard JSON Schema type (zod's .int() emits it), and one integer
  // parameter on any frontend tool made every run fail before the model call.
  it("accepts integer parameters and keeps them integral", async () => {
    const tool = convertAGUIToolToLangChain({
      name: "set_quantity",
      description: "Set the cart quantity",
      parameters: {
        type: "object",
        properties: { quantity: { type: "integer", description: "How many" } },
        required: ["quantity"],
      },
    } as any);

    const schema = tool.schema as any;
    expect(schema.safeParse({ quantity: 3 }).success).toBe(true);
    expect(schema.safeParse({ quantity: 2.5 }).success).toBe(false);
  });
});
