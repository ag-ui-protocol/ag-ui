/** AWS Strands integration for AG-UI. */

export {
  StrandsAgent,
  buildSnapshotMessages,
  buildStrandsSeed,
  convertMessagesForStrandsSeed,
} from "./agent";
export type { StrandsAgentOptions } from "./agent";

export {
  createProxyTool,
  syncProxyTools,
  isProxyTool,
} from "./client-proxy-tool";
export type { StrandsToolRegistry } from "./client-proxy-tool";

export { convertAguiContentToStrands, flattenContentToText } from "./utils";

// Server-side Express transport helpers (`createStrandsApp`,
// `addStrandsExpressEndpoint`, `addPing`, `addCapabilities`,
// `capabilitiesFor`, `DEFAULT_CAPABILITIES`, and associated types) live at
// `@ag-ui/aws-strands/server`. Keeping them off the main entry lets
// client-side bundlers (Next.js, Vite, etc.) trace this package without
// pulling Express / cors into the browser graph.

export type { Logger } from "./logger";

export { buildContextExtras } from "./config";
export type {
  StrandsAgentConfig,
  ToolBehavior,
  ToolCallContext,
  ToolCallContextExtras,
  ToolResultContext,
  PredictStateMapping,
  SessionManagerProvider,
  StateContextBuilder,
  StateFromArgs,
  StateFromResult,
  CustomResultHandler,
  ArgsStreamer,
  MaybePromise,
  StatePayload,
} from "./config";

// Thin HttpAgent subclass for AG-UI clients pointing at a Strands endpoint.
import { HttpAgent } from "@ag-ui/client";
export class AWSStrandsAgent extends HttpAgent {}
