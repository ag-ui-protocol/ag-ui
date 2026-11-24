import {
  type AgentToRendererMessage,
  type CreateSurfaceMessage,
  MessageProcessor,
  STRICT_VALIDATION,
} from "@a2ui/web_core/v1_0";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  A2uiMcpError,
  assertPayloadSize,
  isA2uiMimeType,
  parseA2uiMessages,
} from "./a2ui-messages";
import type { A2uiTemplate } from "./template-store";

export type A2uiCatalogs = ConstructorParameters<typeof MessageProcessor>[0];

export interface BuildSurfaceOptions {
  presentationId: string;
  maxPayloadBytes: number;
  catalogs?: A2uiCatalogs;
}

type SurfacePayload = CreateSurfaceMessage["createSurface"];

interface SurfaceDraft {
  payload: SurfacePayload;
  componentIds: Set<string>;
  foldable: boolean;
}

const RESULT_OPERATIONS = ["updateComponents", "updateDataModel"] as const;

type ValidationConfig = typeof STRICT_VALIDATION;

const ACTION_VALIDATION: ValidationConfig = {
  ...STRICT_VALIDATION,
  allowDanglingReferences: true,
  allowOrphanComponents: true,
};

export function buildSurfaceMessages(
  template: A2uiTemplate,
  result: CallToolResult,
  options: BuildSurfaceOptions,
): AgentToRendererMessage[] {
  if (result.isError) {
    throw new A2uiMcpError("The MCP tool reported an error.");
  }

  const messages = structuredClone(template) as AgentToRendererMessage[];
  const surfaces = createSurfaces(messages, options.presentationId);
  const componentUpdates = foldComponentUpdates(messages, surfaces);
  const resultOperations = readResultOperations(result, surfaces, options);
  if (resultOperations.length === 0) {
    applyStructuredContent(result, surfaces);
  }

  const creates = toCreateSurfaceMessages(surfaces);
  const output = [...creates, ...componentUpdates, ...resultOperations];
  if (options.catalogs) {
    validateMessages(output, options.catalogs);
  }
  return output;
}

export function buildActionMessages(
  template: A2uiTemplate,
  result: CallToolResult,
  options: BuildSurfaceOptions,
): AgentToRendererMessage[] {
  const messages = structuredClone(template) as AgentToRendererMessage[];
  const surfaces = createSurfaces(messages, options.presentationId);
  const componentUpdates = foldComponentUpdates(messages, surfaces);
  const resultOperations = readResultOperations(result, surfaces, options);

  if (options.catalogs) {
    const creates = toCreateSurfaceMessages(surfaces);
    const output = [...creates, ...componentUpdates, ...resultOperations];
    validateMessages(output, options.catalogs, ACTION_VALIDATION);
  }
  return resultOperations;
}

export function findTemplateSurfaceId(
  template: A2uiTemplate,
  presentationId: string,
  surfaceId: string,
): string {
  const surfaces = createSurfaces(template, presentationId);
  for (const templateSurfaceId of surfaces.keys()) {
    if (surfaces.get(templateSurfaceId)?.payload.surfaceId === surfaceId) {
      return templateSurfaceId;
    }
  }
  throw new A2uiMcpError(
    `The surface '${surfaceId}' does not belong to this template.`,
  );
}

function createSurfaces(
  messages: readonly AgentToRendererMessage[],
  presentationId: string,
): Map<string, SurfaceDraft> {
  const surfaces = new Map<string, SurfaceDraft>();

  for (const message of messages) {
    if ("createSurface" in message) {
      const surfaceId = `${message.createSurface.surfaceId}-${presentationId}`;
      const components = message.createSurface.components ?? [];
      const ids = components.map(componentId);
      surfaces.set(message.createSurface.surfaceId, {
        payload: {
          ...message.createSurface,
          surfaceId,
          components,
        },
        componentIds: new Set(ids),
        foldable: true,
      });
    }
  }

  return surfaces;
}

function foldComponentUpdates(
  messages: AgentToRendererMessage[],
  surfaces: Map<string, SurfaceDraft>,
): AgentToRendererMessage[] {
  const keptUpdates: AgentToRendererMessage[] = [];

  for (const message of messages) {
    if ("updateComponents" in message) {
      const surface = requireSurface(
        surfaces,
        message.updateComponents.surfaceId,
      );
      const components = message.updateComponents.components;
      const ids = components.map(componentId);
      const collides = ids.some((id) => surface.componentIds.has(id));

      if (surface.foldable && !collides) {
        foldInto(surface, components, ids);
      } else {
        surface.foldable = false;
        keptUpdates.push(withSurfaceId(message, surfaces));
      }
    }
  }

  return keptUpdates;
}

function foldInto(
  surface: SurfaceDraft,
  components: unknown[],
  ids: string[],
): void {
  surface.payload.components = [
    ...(surface.payload.components ?? []),
    ...components,
  ];
  for (const id of ids) {
    surface.componentIds.add(id);
  }
}

function readResultOperations(
  result: CallToolResult,
  surfaces: Map<string, SurfaceDraft>,
  options: BuildSurfaceOptions,
): AgentToRendererMessage[] {
  const texts = readEmbeddedA2uiTexts(result);
  assertPayloadSize(texts, options.maxPayloadBytes);

  const operations: AgentToRendererMessage[] = [];
  for (const text of texts) {
    const parsed = parseA2uiMessages(text, RESULT_OPERATIONS);
    for (const message of parsed) {
      operations.push(withSurfaceId(message, surfaces));
    }
  }
  return operations;
}

function readEmbeddedA2uiTexts(result: CallToolResult): string[] {
  const texts: string[] = [];

  for (const item of result.content ?? []) {
    if (item.type !== "resource" || !isA2uiMimeType(item.resource.mimeType)) {
      continue;
    }

    const text = item.resource.text;
    if (typeof text !== "string") {
      throw new A2uiMcpError(
        `Embedded A2UI resource ${item.resource.uri} has no text content.`,
      );
    }

    texts.push(text);
  }

  return texts;
}

function applyStructuredContent(
  result: CallToolResult,
  surfaces: Map<string, SurfaceDraft>,
): void {
  const data = result.structuredContent;
  if (!isRecord(data)) {
    return;
  }

  for (const surface of surfaces.values()) {
    surface.payload.dataModel = { ...surface.payload.dataModel, ...data };
  }
}

function toCreateSurfaceMessages(
  surfaces: Map<string, SurfaceDraft>,
): AgentToRendererMessage[] {
  return [...surfaces.values()].map((surface) => ({
    version: "1.0",
    createSurface: surface.payload,
  }));
}

function withSurfaceId(
  message: AgentToRendererMessage,
  surfaces: Map<string, SurfaceDraft>,
): AgentToRendererMessage {
  if ("updateComponents" in message) {
    const surface = requireSurface(
      surfaces,
      message.updateComponents.surfaceId,
    );
    return {
      version: "1.0",
      updateComponents: {
        ...message.updateComponents,
        surfaceId: surface.payload.surfaceId,
      },
    };
  }

  if ("updateDataModel" in message) {
    const surface = requireSurface(surfaces, message.updateDataModel.surfaceId);
    return {
      version: "1.0",
      updateDataModel: {
        ...message.updateDataModel,
        surfaceId: surface.payload.surfaceId,
      },
    };
  }

  return message;
}

function requireSurface(
  surfaces: Map<string, SurfaceDraft>,
  surfaceId: string,
): SurfaceDraft {
  const surface = surfaces.get(surfaceId);
  if (!surface) {
    throw new A2uiMcpError(
      `A2UI operation targets surface '${surfaceId}', which the template does not create.`,
    );
  }
  return surface;
}

function componentId(component: unknown): string {
  if (isRecord(component) && typeof component["id"] === "string") {
    return component["id"];
  }
  throw new A2uiMcpError("A2UI component without id.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMessages(
  messages: AgentToRendererMessage[],
  catalogs: A2uiCatalogs,
  validationConfig: ValidationConfig = STRICT_VALIDATION,
): void {
  const processor = new MessageProcessor(catalogs, undefined, {
    validationConfig,
  });
  try {
    const copy = structuredClone(messages);
    const errors = processor.processMessagesWithErrors(copy);
    if (errors.length > 0) {
      const details = errors.map((entry) => entry.error.message).join(" ");
      throw new A2uiMcpError(`Invalid A2UI surface: ${details}`);
    }
  } finally {
    processor.dispose();
  }
}
