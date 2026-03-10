import type {
  TextMessageChunkEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from '@ag-ui/client';
import { EventType, randomUUID } from '@ag-ui/client';
import type {
  ChunkByType,
  ChunkHandler,
  CreateDefaultRegistryOptions,
  HandlerErrorMode,
  RegisterMode,
  StreamChunk,
  StreamChunkName,
  StreamRunContext,
} from './types';

/**
 * Normalizes unknown error-like values into Error objects.
 * @param value Raw error-like value from stream handlers.
 */
function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  if (typeof value === 'string') {
    return new Error(value);
  }

  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

/**
 * Safely serializes arbitrary values for event payload fields.
 * @param value Value to stringify.
 */
function stringifyValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Updates current message ID from step-level chunk metadata when available.
 * @param chunk Step chunk carrying optional `messageId` metadata.
 * @param context Current stream run context.
 */
function syncMessageIdFromStep(
  chunk: ChunkByType<'step-start'> | ChunkByType<'step-finish'>,
  context: StreamRunContext,
): void {
  const stepMessageId = chunk.payload.messageId;
  if (typeof stepMessageId !== 'string') {
    return;
  }

  context.syncMessageId(stepMessageId);
}

/**
 * Type guard used to route generic stream chunks to typed handlers.
 * @param chunk Stream chunk to inspect.
 * @param type Expected chunk type.
 */
function isChunkOfType<T extends StreamChunkName>(
  chunk: StreamChunk,
  type: T,
): chunk is ChunkByType<T> {
  return chunk.type === type;
}

/** Registry for mapping stream chunk types to one or more handler callbacks. */
export class ChunkHandlerRegistry {
  /** Internal handler table indexed by chunk `type`. */
  private readonly handlers = new Map<StreamChunkName, ChunkHandler[]>();

  /**
   * Creates a registry instance with configurable error behavior.
   * @param errorMode Handler error strategy.
   * @param onHandlerError Callback executed when a handler throws.
   */
  constructor(
    private readonly errorMode: HandlerErrorMode = 'fail-fast',
    private readonly onHandlerError?: (error: Error, chunkType: StreamChunkName) => void,
  ) {}

  /**
   * Registers handler(s) for a chunk type with replace/append/skip semantics.
   * @param type Chunk type discriminator.
   * @param handler Handler callback to register.
   * @param mode Registration strategy when handlers already exist.
   */
  register<T extends StreamChunkName>(
    type: T,
    handler: ChunkHandler<ChunkByType<T>>,
    mode: RegisterMode = 'replace',
  ): this {
    const wrapped: ChunkHandler = (chunk, context) => {
      if (isChunkOfType(chunk, type)) {
        handler(chunk, context);
      }
    };

    const current = this.handlers.get(type) ?? [];
    if (mode === 'skip' && current.length > 0) {
      return this;
    }

    const next = mode === 'append' ? [...current, wrapped] : [wrapped];
    this.handlers.set(type, next);
    return this;
  }

  /**
   * Dispatches one chunk through all handlers registered for its type.
   * @param chunk Chunk emitted by Mastra stream.
   * @param context Mutable run context shared across handlers.
   */
  process(chunk: StreamChunk, context: StreamRunContext): void {
    const handlers = this.handlers.get(chunk.type);
    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      try {
        handler(chunk, context);
      } catch (error) {
        const resolvedError = toError(error);
        this.onHandlerError?.(resolvedError, chunk.type);
        if (this.errorMode === 'fail-fast') {
          throw resolvedError;
        }
      }
    }
  }

  /** Creates a shallow-cloned registry preserving handler order and options. */
  clone(): ChunkHandlerRegistry {
    const cloned = new ChunkHandlerRegistry(this.errorMode, this.onHandlerError);
    for (const [type, handlers] of this.handlers.entries()) {
      cloned.handlers.set(type, [...handlers]);
    }
    return cloned;
  }
}

/**
 * Builds the default AG-UI event mapping registry for Mastra stream chunks.
 * @param options Registry construction options.
 */
export function createDefaultRegistry(
  options: CreateDefaultRegistryOptions = {},
): ChunkHandlerRegistry {
  const registry = new ChunkHandlerRegistry(
    options.errorMode ?? 'fail-fast',
    options.onHandlerError,
  );

  registry.register('text-delta', (chunk, context) => {
    const event: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      role: 'assistant',
      messageId: context.messageId,
      delta: chunk.payload.text,
    };

    context.emit(event);
    context.hasEmittedText = true;
  });

  registry.register('tool-call', (chunk, context) => {
    const startEvent: ToolCallStartEvent = {
      type: EventType.TOOL_CALL_START,
      parentMessageId: context.messageId,
      toolCallId: chunk.payload.toolCallId,
      toolCallName: chunk.payload.toolName,
    };

    const argsEvent: ToolCallArgsEvent = {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: chunk.payload.toolCallId,
      delta: stringifyValue(chunk.payload.args),
    };

    const endEvent: ToolCallEndEvent = {
      type: EventType.TOOL_CALL_END,
      toolCallId: chunk.payload.toolCallId,
    };

    context.emit(startEvent);
    context.emit(argsEvent);
    context.emit(endEvent);
  });

  registry.register('tool-result', (chunk, context) => {
    const event: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: chunk.payload.toolCallId,
      content: stringifyValue(chunk.payload.result),
      messageId: randomUUID(),
      role: 'tool',
    };

    context.emit(event);
  });

  registry.register('step-start', syncMessageIdFromStep);
  registry.register('step-finish', syncMessageIdFromStep);

  registry.register('finish', (_chunk, context) => {
    context.rotateMessageId();
  });

  registry.register('abort', (_chunk, context) => {
    context.markAborted();
  });

  registry.register('tool-error', (chunk, context) => {
    context.logger.error('stream.tool.error', {
      threadId: context.threadId,
      runId: context.runId,
      toolCallId: chunk.payload.toolCallId,
      toolName: chunk.payload.toolName,
    });

    context.fail(toError(chunk.payload.error));
    context.markAborted();
  });

  registry.register('error', (chunk, context) => {
    context.fail(toError(chunk.payload.error));
    context.markAborted();
  });

  return registry;
}
