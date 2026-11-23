import type { AgentToRendererMessage } from "@a2ui/web_core/v1_0";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

import {
  A2uiMcpError,
  assertPayloadSize,
  isA2uiMimeType,
  operationKind,
  parseA2uiMessages,
} from "./a2ui-messages";

export type A2uiTemplate = readonly AgentToRendererMessage[];

export type ResourceReader = (uri: string) => Promise<ReadResourceResult>;

export interface TemplateStoreOptions {
  ttlMs: number;
  maxPayloadBytes: number;
}

interface TemplateCacheEntry {
  expiresAt: number;
  template: Promise<A2uiTemplate | null>;
}

const TEMPLATE_OPERATIONS = ["createSurface", "updateComponents"] as const;

export class TemplateStore {
  private readonly entries = new Map<string, TemplateCacheEntry>();

  constructor(private readonly options: TemplateStoreOptions) {}

  load(
    scope: string,
    uri: string,
    read: ResourceReader,
  ): Promise<A2uiTemplate | null> {
    const key = JSON.stringify([scope, uri]);
    const now = Date.now();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.template;
    }

    const template = this.fetch(uri, read);
    const entry: TemplateCacheEntry = {
      expiresAt: now + this.options.ttlMs,
      template,
    };
    this.entries.set(key, entry);

    template.catch(() => {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
    });

    return template;
  }

  private async fetch(
    uri: string,
    read: ResourceReader,
  ): Promise<A2uiTemplate | null> {
    const result = await read(uri);
    const content =
      result.contents.find((item) => item.uri === uri) ?? result.contents[0];

    if (!content || !isA2uiMimeType(content.mimeType)) {
      return null;
    }

    const text = content.text;
    if (typeof text !== "string") {
      throw new A2uiMcpError(`A2UI resource ${uri} has no text content.`);
    }

    assertPayloadSize([text], this.options.maxPayloadBytes);
    const messages = parseA2uiMessages(text, TEMPLATE_OPERATIONS);
    const createsSurface = messages.some(
      (message) => operationKind(message) === "createSurface",
    );
    if (!createsSurface) {
      throw new A2uiMcpError(`A2UI resource ${uri} creates no surface.`);
    }

    return Object.freeze(messages);
  }
}
