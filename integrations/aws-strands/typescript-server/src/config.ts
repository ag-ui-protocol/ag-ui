import { AguiEvent, RunAgentInput } from "./types";

export type StatePayload = Record<string, unknown>;

export interface ToolCallContext {
  inputData: RunAgentInput;
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
  argsStr: string;
}

export interface ToolResultContext extends ToolCallContext {
  resultData: unknown;
  messageId: string;
}

export type ArgsStreamer = (
  context: ToolCallContext
) => AsyncIterable<string | null | undefined> | Iterable<string | null | undefined>;

export type StateFromArgs = (
  context: ToolCallContext
) => Promise<StatePayload | null | undefined> | StatePayload | null | undefined;

export type StateFromResult = (
  context: ToolResultContext
) => Promise<StatePayload | null | undefined> | StatePayload | null | undefined;

export type CustomResultHandler = (
  context: ToolResultContext
) =>
  | AsyncIterable<AguiEvent | null | undefined>
  | Iterable<AguiEvent | null | undefined>;

export type StateContextBuilder = (
  inputData: RunAgentInput,
  userMessage: string
) => string | Promise<string>;

export class PredictStateMapping {
  stateKey: string;
  tool: string;
  toolArgument: string;

  constructor(args: { stateKey: string; tool: string; toolArgument: string }) {
    this.stateKey = args.stateKey;
    this.tool = args.tool;
    this.toolArgument = args.toolArgument;
  }

  toPayload(): Record<string, string> {
    return {
      state_key: this.stateKey,
      tool: this.tool,
      tool_argument: this.toolArgument,
    };
  }
}

export interface ToolBehavior {
  skipMessagesSnapshot?: boolean;
  continueAfterFrontendCall?: boolean;
  stopStreamingAfterResult?: boolean;
  predictState?: Iterable<PredictStateMapping> | PredictStateMapping | null;
  argsStreamer?: ArgsStreamer | null;
  stateFromArgs?: StateFromArgs | null;
  stateFromResult?: StateFromResult | null;
  customResultHandler?: CustomResultHandler | null;
}

export interface StrandsAgentConfig {
  toolBehaviors?: Record<string, ToolBehavior>;
  stateContextBuilder?: StateContextBuilder | null;
}

export async function maybeAwait<T>(value: Promise<T> | T): Promise<T> {
  return await value;
}

export function normalizePredictState(
  value?: Iterable<PredictStateMapping> | PredictStateMapping | null
): PredictStateMapping[] {
  if (!value) return [];
  if (value instanceof PredictStateMapping) return [value];
  return Array.from(value);
}
