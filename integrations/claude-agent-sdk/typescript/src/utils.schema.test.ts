import { describe, expect, it } from "vitest";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@ag-ui/core";
import { convertAguiToolToClaudeSdk } from "./utils";

/** Serve one converted frontend tool over MCP, as the model would see it. */
async function connectFrontendTool(
  toolDef: Tool,
  resolve: (name: string, args: Record<string, unknown>) => string = () => "ok",
) {
  const server = createSdkMcpServer({
    name: "ag_ui",
    tools: [convertAguiToolToClaudeSdk(toolDef, resolve)],
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  return { client, inputSchema: tools[0].inputSchema };
}

const showFlights: Tool = {
  name: "show_flights",
  description: "Render flight options",
  parameters: {
    type: "object",
    properties: {
      flights: {
        type: "array",
        description: "Flights to show",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Flight id" },
            airline: { type: "string" },
            stops: { type: "integer" },
            cabin: { type: "string", enum: ["economy", "business"] },
            price: {
              type: "object",
              properties: {
                amount: { type: "number" },
                currency: { type: "string" },
              },
              required: ["amount"],
            },
          },
          required: ["id", "airline"],
        },
      },
    },
    required: ["flights"],
  },
};

describe("frontend tool parameter schemas", () => {
  it("keeps nested array item and object schemas visible to the model", async () => {
    const { inputSchema } = await connectFrontendTool(showFlights);

    expect(inputSchema).toMatchObject({
      type: "object",
      required: ["flights"],
      properties: {
        flights: {
          type: "array",
          description: "Flights to show",
          items: {
            type: "object",
            required: ["id", "airline"],
            properties: {
              id: { type: "string", description: "Flight id" },
              airline: { type: "string" },
              stops: { type: "integer" },
              cabin: { type: "string", enum: ["economy", "business"] },
              price: {
                type: "object",
                required: ["amount"],
                properties: {
                  amount: { type: "number" },
                  currency: { type: "string" },
                },
              },
            },
          },
        },
      },
    });
  });

  it("passes the model's nested input to the frontend result unchanged", async () => {
    const received: Record<string, unknown>[] = [];
    const { client } = await connectFrontendTool(showFlights, (_, args) => {
      received.push(args);
      return "rendered";
    });
    const args = {
      flights: [
        { id: "f1", airline: "KLM", price: { amount: 120, note: "extra" } },
      ],
    };

    const result = await client.callTool({
      name: "show_flights",
      arguments: args,
    });

    expect(result.isError).toBeFalsy();
    expect(received).toEqual([args]);
  });

  it("falls back to an open schema for constructs it cannot convert", async () => {
    const { inputSchema } = await connectFrontendTool({
      name: "odd",
      description: "",
      parameters: {
        type: "object",
        properties: {
          ref: { $ref: "#/$defs/thing", description: "Referenced" },
          merged: { allOf: [{ type: "string" }] },
          tuple: { type: "array", items: [{ type: "string" }] },
          emptyEnum: { type: "string", enum: [] },
          unknownType: { type: "date" },
          nullable: { type: ["string", "null"] },
          choice: { anyOf: [{ type: "string" }, { type: "number" }] },
          mixedEnum: { enum: ["a", 1, null] },
          objectEnum: { enum: [{ a: 1 }] },
          map: { type: "object", additionalProperties: { type: "number" } },
          notASchema: "string",
        },
        required: "not-an-array",
      },
    });
    const properties = (inputSchema as { properties: Record<string, object> })
      .properties;

    expect(properties.ref).toEqual({ description: "Referenced" });
    expect(properties.merged).toEqual({});
    expect(properties.tuple).toMatchObject({ type: "array" });
    expect(properties.tuple).not.toHaveProperty("items.type");
    expect(properties.emptyEnum).toEqual({ type: "string" });
    expect(properties.unknownType).toEqual({});
    expect(properties.nullable).toEqual({ type: ["string", "null"] });
    expect(properties.choice).toEqual({ type: ["string", "number"] });
    expect(properties.objectEnum).toEqual({});
    expect(properties.map).toMatchObject({
      type: "object",
      additionalProperties: { type: "number" },
    });
    expect(properties.notASchema).toEqual({});
    expect(inputSchema).not.toHaveProperty("required");
  });
});
