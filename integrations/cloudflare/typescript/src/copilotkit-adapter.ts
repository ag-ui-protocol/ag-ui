import { CloudflareAGUIAdapter } from "./adapter";
import type { CloudflareAGUIAdapterOptions } from "./adapter";

/**
 * CopilotKit-compatible adapter for Cloudflare Workers AI
 * This extends CloudflareAGUIAdapter to work seamlessly with CopilotKit
 */
export class CopilotKitCloudflareAdapter extends CloudflareAGUIAdapter {
  constructor(options: CloudflareAGUIAdapterOptions) {
    super(options);
  }

  // The process method is already implemented in the base CloudflareAGUIAdapter class
  // This class exists to ensure proper TypeScript compatibility with CopilotKit
}

/**
 * Factory function to create a CopilotKit-compatible Cloudflare adapter
 */
export function createCopilotKitCloudflareAdapter(options: CloudflareAGUIAdapterOptions) {
  return new CopilotKitCloudflareAdapter(options);
}
