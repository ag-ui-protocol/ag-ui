import {
  type AgentToRendererMessage,
  basicCatalog,
  MessageProcessor,
} from "@a2ui/web_core/v1_0";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { A2uiMcpError } from "../src/a2ui/a2ui-messages";
import {
  buildSurfaceMessages,
  type BuildSurfaceOptions,
} from "../src/a2ui/build-surface";
import { A2UI_MIME_TYPE } from "../src/a2ui/protocol";
import {
  BASIC_CATALOG_ID,
  customer,
  customerComponents,
  customerTemplate,
} from "./a2ui/fixtures";

const options: BuildSurfaceOptions = {
  presentationId: "call-1",
  catalogs: [basicCatalog],
  maxPayloadBytes: 64 * 1024,
};

const template = customerTemplate as AgentToRendererMessage[];

function text(id: string, path: string) {
  return { id, component: "Text", text: { "@path": path } };
}

function structured(data: Record<string, unknown>): CallToolResult {
  return { content: [], structuredContent: data };
}

describe("buildSurfaceMessages", () => {
  it("folds multiple surfaces and component updates into createSurface", () => {
    const multiSurface: AgentToRendererMessage[] = [
      {
        version: "1.0",
        createSurface: { surfaceId: "header", catalogId: BASIC_CATALOG_ID },
      },
      {
        version: "1.0",
        createSurface: { surfaceId: "body", catalogId: BASIC_CATALOG_ID },
      },
      {
        version: "1.0",
        updateComponents: {
          surfaceId: "body",
          components: [text("root", "/customer/email")],
        },
      },
      {
        version: "1.0",
        updateComponents: {
          surfaceId: "header",
          components: [text("root", "/customer/name")],
        },
      },
    ];

    const result = structured({ customer: customer("m") });
    const messages = buildSurfaceMessages(multiSurface, result, options);

    expect(messages).toEqual([
      {
        version: "1.0",
        createSurface: {
          surfaceId: "header-call-1",
          catalogId: BASIC_CATALOG_ID,
          components: [text("root", "/customer/name")],
          dataModel: { customer: customer("m") },
        },
      },
      {
        version: "1.0",
        createSurface: {
          surfaceId: "body-call-1",
          catalogId: BASIC_CATALOG_ID,
          components: [text("root", "/customer/email")],
          dataModel: { customer: customer("m") },
        },
      },
    ]);
  });

  it("keeps component updates that replace existing components", () => {
    const replacing: AgentToRendererMessage[] = [
      ...template,
      {
        version: "1.0",
        updateComponents: {
          surfaceId: "customer-details",
          components: [text("email", "/customer/id")],
        },
      },
    ];

    const result = structured({ customer: customer("k") });
    const messages = buildSurfaceMessages(replacing, result, options);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({
      version: "1.0",
      updateComponents: {
        surfaceId: "customer-details-call-1",
        components: [text("email", "/customer/id")],
      },
    });
  });

  it("rejects surfaces without catalogId when catalogs are configured", () => {
    const withoutCatalog: AgentToRendererMessage[] = [
      {
        version: "1.0",
        createSurface: {
          surfaceId: "plain",
          components: [text("root", "/title")],
        },
      },
    ];

    const result = structured({ title: "Hi" });

    expect(() => buildSurfaceMessages(withoutCatalog, result, options)).toThrow(
      "surface 'plain-call-1' has no default catalogId",
    );
  });

  it("skips the catalog check without configured catalogs", () => {
    const unknownComponent: AgentToRendererMessage[] = [
      {
        version: "1.0",
        createSurface: {
          surfaceId: "plain",
          components: [{ id: "root", component: "Bogus" }],
        },
      },
    ];
    const withoutCatalogs = { ...options, catalogs: undefined };

    const result = structured({});
    const messages = buildSurfaceMessages(
      unknownComponent,
      result,
      withoutCatalogs,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toHaveProperty("createSurface.catalogId");
  });

  it("does not mutate the template", () => {
    const before = JSON.stringify(template);

    const result = structured({ customer: customer("t") });
    buildSurfaceMessages(template, result, options);

    expect(JSON.stringify(template)).toBe(before);
  });

  it("produces a data model that the bindings resolve against", () => {
    const result = structured({ customer: customer("d") });
    const messages = buildSurfaceMessages(template, result, options);

    const processor = new MessageProcessor([basicCatalog]);
    processor.processMessages(messages);
    const surface = processor.getSurface("customer-details-call-1");

    expect(surface?.dataModel.get("/customer/name")).toBe("Customer d");
    expect(surface?.dataModel.get("/customer/email")).toBe("d@example.com");
    expect(messages[0]).toMatchObject({
      createSurface: { components: customerComponents },
    });
    processor.dispose();
  });

  it("remaps the surface of embedded A2UI operations", () => {
    const operations = [
      {
        version: "1.0",
        updateDataModel: {
          surfaceId: "customer-details",
          value: { customer: customer("e") },
        },
      },
    ];
    const result: CallToolResult = {
      content: [
        {
          type: "resource",
          resource: {
            uri: "a2ui://customer-details/data",
            mimeType: A2UI_MIME_TYPE,
            text: JSON.stringify(operations),
          },
        },
      ],
    };

    const messages = buildSurfaceMessages(template, result, options);

    expect(messages[1]).toEqual({
      version: "1.0",
      updateDataModel: {
        surfaceId: "customer-details-call-1",
        value: { customer: customer("e") },
      },
    });
  });

  it("rejects embedded operations for surfaces the template does not create", () => {
    const operations = [
      { version: "1.0", updateDataModel: { surfaceId: "other", value: {} } },
    ];
    const result: CallToolResult = {
      content: [
        {
          type: "resource",
          resource: {
            uri: "a2ui://other/data",
            mimeType: A2UI_MIME_TYPE,
            text: JSON.stringify(operations),
          },
        },
      ],
    };

    expect(() => buildSurfaceMessages(template, result, options)).toThrow(
      A2uiMcpError,
    );
  });

  it("limits the total size of all embedded A2UI resources", () => {
    const operations = [
      {
        version: "1.0",
        updateDataModel: {
          surfaceId: "customer-details",
          path: "/customer",
          value: customer("s"),
        },
      },
    ];
    const text = JSON.stringify(operations);
    const embedded = {
      type: "resource" as const,
      resource: {
        uri: "a2ui://customer-details/data",
        mimeType: A2UI_MIME_TYPE,
        text,
      },
    };
    const result: CallToolResult = { content: [embedded, embedded] };
    const limit = text.length + 1;
    const limited = { ...options, maxPayloadBytes: limit };

    expect(() => buildSurfaceMessages(template, result, limited)).toThrow(
      `A2UI payload exceeds the limit of ${limit} bytes.`,
    );
  });
});
