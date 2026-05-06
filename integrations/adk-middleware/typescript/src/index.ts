import { HttpAgent } from "@ag-ui/client";
import type { AgentCapabilities } from "@ag-ui/core";

/**
 * Lightweight runtime check that the server returned a plain object.
 * All fields on AgentCapabilities are optional, so any non-null object is valid.
 * Returns a safeParse-compatible result shape to keep the call-site unchanged.
 */
function parseAgentCapabilities(data: unknown): { success: true; data: AgentCapabilities } | { success: false; error: { message: string } } {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return { success: true, data: data as AgentCapabilities };
  }
  return { success: false, error: { message: `Expected an object, got ${Array.isArray(data) ? "array" : String(data)}` } };
}

export class ADKAgent extends HttpAgent {
  /**
   * Builds the URL for the capabilities endpoint.
   * Override this to customize the capabilities URL construction.
   */
  protected capabilitiesUrl(): string {
    const parsed = new URL(this.url);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") + "/capabilities";
    return parsed.toString();
  }

  /**
   * Returns the fetch config for capabilities requests.
   * Override this to customize auth, headers, or credentials for capability discovery.
   */
  protected capabilitiesRequestInit(): RequestInit {
    return {
      method: "GET",
      headers: {
        ...this.headers,
        Accept: "application/json",
      },
    };
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    const url = this.capabilitiesUrl();
    const response = await fetch(url, this.capabilitiesRequestInit());

    if (!response.ok) {
      let body: string;
      try {
        body = await response.text();
      } catch {
        body = response.statusText || "(unable to read response body)";
      }
      throw new Error(`Failed to fetch capabilities from ${url}: HTTP ${response.status}: ${body}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (e) {
      throw new Error(
        `Failed to parse capabilities response from ${url}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const result = parseAgentCapabilities(data);
    if (!result.success) {
      throw new Error(
        `Invalid capabilities response from ${url}: ${result.error.message}`,
      );
    }
    return result.data;
  }
}
