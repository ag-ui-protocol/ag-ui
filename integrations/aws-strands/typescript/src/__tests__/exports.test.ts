/** Every public helper must be reachable from its package entry point. */

import { describe, it, expect } from "vitest";
import * as pkg from "../index";
import * as serverPkg from "../server";

describe("public export surface", () => {
  it("main entry exposes the adapter, proxy helpers, content helpers, and context helper", () => {
    const expected = [
      "StrandsAgent",
      "AWSStrandsAgent",
      "buildSnapshotMessages",
      "buildStrandsSeed",
      "convertMessagesForStrandsSeed",
      "buildContextExtras",
      "convertAguiContentToStrands",
      "flattenContentToText",
      "createProxyTool",
      "syncProxyTools",
      "isProxyTool",
    ];
    for (const name of expected) {
      expect(pkg).toHaveProperty(name);
      expect((pkg as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it("server subpath exposes the Express transport helpers", () => {
    const expected = [
      "createStrandsApp",
      "addStrandsExpressEndpoint",
      "addPing",
      "addCapabilities",
      "capabilitiesFor",
      "DEFAULT_CAPABILITIES",
    ];
    for (const name of expected) {
      expect(serverPkg).toHaveProperty(name);
      expect((serverPkg as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it("main entry does NOT expose server-side helpers (bundler safety)", () => {
    // Keeping these off the main entry lets client bundlers (Next.js, Vite)
    // trace this package without pulling in Express / cors.
    const serverOnly = [
      "createStrandsApp",
      "addStrandsExpressEndpoint",
      "addPing",
      "addCapabilities",
    ];
    for (const name of serverOnly) {
      expect(pkg).not.toHaveProperty(name);
    }
  });
});
