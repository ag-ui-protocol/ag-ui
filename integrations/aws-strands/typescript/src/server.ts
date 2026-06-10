/**
 * Server-side entry point for `@ag-ui/aws-strands`.
 *
 * Import from `@ag-ui/aws-strands/server` when you need the Express transport
 * helpers. The main entry point (`@ag-ui/aws-strands`) stays free of Express
 * / cors references so Next.js / Turbopack / Vite bundlers tracing the
 * client-side graph don't pull server-only modules into the browser build.
 */

import {
  addStrandsExpressEndpoint,
  addPing,
  addCapabilities,
} from "./endpoint";
import type { StrandsAgent } from "./agent";
import type { StrandsAguiCapabilitiesOverrides } from "./endpoint";

export {
  addStrandsExpressEndpoint,
  addPing,
  addCapabilities,
  capabilitiesFor,
  DEFAULT_CAPABILITIES,
} from "./endpoint";

export type {
  AddStrandsEndpointOptions,
  StrandsAguiCapabilities,
  StrandsAguiCapabilitiesOverrides,
} from "./endpoint";

export interface CreateStrandsAppOptions {
  /** Path for the agent endpoint. Default `/`. */
  path?: string;
  /** Path for the ping endpoint. Pass `null` or `""` to disable. Default `/ping`. */
  pingPath?: string | null;
  /**
   * Path for the capabilities endpoint. Pass `null` or `""` to disable.
   * Default `/capabilities`.
   */
  capabilitiesPath?: string | null;
  /** Override capabilities advertised at {@link CreateStrandsAppOptions.capabilitiesPath}. */
  capabilities?: StrandsAguiCapabilitiesOverrides;
  /** Override CORS origin. Default `*` (wide-open, matches the Python adapter). */
  corsOrigin?: string | string[] | boolean;
}

/** Create an Express app with a single Strands agent endpoint and optional ping endpoint. */
export async function createStrandsApp(
  agent: StrandsAgent,
  options: CreateStrandsAppOptions = {},
): Promise<import("express").Express> {
  const {
    path = "/",
    pingPath = "/ping",
    capabilitiesPath = "/capabilities",
    capabilities,
    corsOrigin = true,
  } = options;

  // Lazy dynamic imports so `express` / `cors` are only required at runtime
  // when `createStrandsApp` is actually called.
  const expressModule = await import("express");
  const corsModule = await import("cors");
  const express = (expressModule.default ??
    expressModule) as typeof import("express");
  const cors = (corsModule.default ?? corsModule) as typeof import("cors");

  const app = express();
  app.use(cors({ origin: corsOrigin, credentials: true }));
  app.use(express.json({ limit: "50mb" }));

  addStrandsExpressEndpoint(app, agent, { path });

  if (pingPath) {
    addPing(app, pingPath);
  }

  if (capabilitiesPath) {
    addCapabilities(app, capabilitiesPath, { agent, overrides: capabilities });
  }

  return app;
}
