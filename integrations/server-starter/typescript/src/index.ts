import { HttpAgent } from "@ag-ui/client";
import type { AgentCapabilities } from "@ag-ui/core";
import { AgentCapabilitiesSchema } from "@ag-ui/core/schemas";

export class ServerStarterAgent extends HttpAgent {
  /**
   * Builds the URL for the capabilities endpoint (`<url>/capabilities`).
   * Relative agent URLs resolve against the page location, like fetch does.
   * Override this to customize the capabilities URL construction.
   */
  protected capabilitiesUrl(): string {
    const base = (globalThis as { location?: { href?: string } }).location?.href;
    const parsed = new URL(this.url, base);
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

  /**
   * Fetches and validates the server's capabilities. The example server's
   * `/server-history` endpoint uses this to advertise server-managed history
   * (`custom.serverManagedHistory`).
   */
  async getCapabilities(): Promise<AgentCapabilities> {
    const url = this.capabilitiesUrl();
    // Use the agent's fetch so a custom fetch (auth, proxy, runtime) also
    // applies to capability discovery.
    const response = await this.fetch(url, this.capabilitiesRequestInit());

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

    const result = AgentCapabilitiesSchema.safeParse(data);
    if (!result.success) {
      throw new Error(`Invalid capabilities response from ${url}: ${result.error.message}`);
    }
    return result.data;
  }
}
