import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  Middleware,
  randomUUID,
  type RunAgentInput,
  type RunFinishedEvent,
  type RunStartedEvent,
} from "@ag-ui/client";
import { concatMap, from, type Observable, of } from "rxjs";

import {
  A2UI_ACTION_TOOL,
  type A2uiActionMode,
  type McpAction,
  readMcpAction,
} from "./a2ui-actions";
import { a2uiDelta, a2uiSnapshot, errorSnapshot } from "./activity-snapshots";
import {
  type A2uiCatalogs,
  buildActionMessages,
  buildSurfaceMessages,
  type BuildSurfaceOptions,
  findTemplateSurfaceId,
} from "./build-surface";
import {
  type A2uiSource,
  isA2uiCandidate,
  readA2uiSource,
  readToolCallId,
} from "./mcp-apps-events";
import {
  callMcpTool,
  type McpServerRef,
  readMcpResource,
} from "./mcp-apps-proxy";
import type { A2uiMcpOrigin } from "./protocol";
import { type A2uiTemplate, TemplateStore } from "./template-store";

export interface A2uiMcpMiddlewareConfig {
  catalogs?: A2uiCatalogs;
  templateCacheTtlMs?: number;
  maxPayloadBytes?: number;
  actions?: A2uiActionMode;
}

const DEFAULT_TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;

export class A2uiMcpMiddleware extends Middleware {
  private readonly catalogs?: A2uiCatalogs;
  private readonly maxPayloadBytes: number;
  private readonly actions: A2uiActionMode;
  private readonly templates: TemplateStore;

  constructor(config: A2uiMcpMiddlewareConfig = {}) {
    super();
    this.catalogs = config.catalogs;
    this.maxPayloadBytes = config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.actions = config.actions ?? "agent";
    this.templates = new TemplateStore({
      maxPayloadBytes: this.maxPayloadBytes,
      ttlMs: config.templateCacheTtlMs ?? DEFAULT_TEMPLATE_CACHE_TTL_MS,
    });
  }

  override run(
    input: RunAgentInput,
    next: AbstractAgent,
  ): Observable<BaseEvent> {
    const action = this.actions === "mcp" ? readMcpAction(input) : undefined;
    if (!action) {
      return this.renderSurfaces(input, next);
    }

    const handled = this.handleAction(action, input, next);
    return from(handled).pipe(
      concatMap((events) => {
        if (!events) {
          return this.renderSurfaces(input, next);
        }
        return from(events);
      }),
    );
  }

  private renderSurfaces(
    input: RunAgentInput,
    next: AbstractAgent,
  ): Observable<BaseEvent> {
    let toolCallId: string | undefined;

    return next.run(input).pipe(
      concatMap((event) => {
        toolCallId = readToolCallId(event) ?? toolCallId;

        if (!isA2uiCandidate(event)) {
          return of(event);
        }

        const source = readA2uiSource(event);
        const presentationId = toolCallId ?? randomUUID();
        const snapshot = this.render(source, presentationId, input, next);
        return from(snapshot);
      }),
    );
  }

  private async render(
    source: A2uiSource,
    presentationId: string,
    input: RunAgentInput,
    next: AbstractAgent,
  ): Promise<BaseEvent> {
    try {
      const content = source.content;
      const template = await this.loadTemplate(
        content,
        source.resourceUri,
        input,
        next,
      );
      if (!template) {
        return source.snapshot;
      }

      const options = this.buildOptions(presentationId);
      const operations = buildSurfaceMessages(
        template,
        content.result,
        options,
      );
      const mcp: A2uiMcpOrigin = {
        serverHash: content.serverHash,
        serverId: content.serverId,
        resourceUri: source.resourceUri,
        presentationId,
      };
      return a2uiSnapshot(presentationId, { a2ui_operations: operations, mcp });
    } catch (error) {
      console.error(`A2UI over MCP failed for ${source.resourceUri}`, error);
      return errorSnapshot(presentationId, source.resourceUri, error);
    }
  }

  private async handleAction(
    action: McpAction,
    input: RunAgentInput,
    next: AbstractAgent,
  ): Promise<BaseEvent[] | null> {
    const origin = action.mcp;
    try {
      const template = await this.loadTemplate(
        origin,
        origin.resourceUri,
        input,
        next,
      );
      if (!template) {
        return null;
      }

      const surfaceId = findTemplateSurfaceId(
        template,
        origin.presentationId,
        action.userAction.surfaceId,
      );
      const args = { ...action.userAction, surfaceId };
      const result = await callMcpTool(
        origin,
        A2UI_ACTION_TOOL,
        args,
        input,
        next,
      );
      const options = this.buildOptions(origin.presentationId);
      const operations = buildActionMessages(template, result, options);

      const started: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      };
      const finished: RunFinishedEvent = {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      };
      const delta = a2uiDelta(origin.presentationId, operations);
      return [started, delta, finished];
    } catch (error) {
      console.warn(
        `A2UI action ${action.userAction.name} is passed on to the agent.`,
        error,
      );
      return null;
    }
  }

  private loadTemplate(
    server: McpServerRef,
    resourceUri: string,
    input: RunAgentInput,
    next: AbstractAgent,
  ): Promise<A2uiTemplate | null> {
    const scope = `${server.serverHash}:${server.serverId ?? ""}`;
    return this.templates.load(scope, resourceUri, (uri) =>
      readMcpResource(server, uri, input, next),
    );
  }

  private buildOptions(presentationId: string): BuildSurfaceOptions {
    return {
      presentationId,
      maxPayloadBytes: this.maxPayloadBytes,
      catalogs: this.catalogs,
    };
  }
}
