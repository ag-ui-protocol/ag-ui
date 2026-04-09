import { AbstractAgent, RunAgentResult } from "./agent";
import { runHttpRequest } from "@/run/http-request";
import { HttpAgentConfig, RunAgentParameters } from "./types";
import { RunAgentInput, BaseEvent, AgentCapabilities, AgentCapabilitiesSchema } from "@ag-ui/core";
import { structuredClone_ } from "@/utils";
import { transformHttpEventStream } from "@/transform/http";
import { Observable } from "rxjs";
import { AgentSubscriber } from "./subscriber";

interface RunHttpAgentConfig extends RunAgentParameters {
  abortController?: AbortController;
}

export class HttpAgent extends AbstractAgent {
  public url: string;
  public headers: Record<string, string>;
  public abortController: AbortController = new AbortController();

  /**
   * Returns the fetch config for the http request.
   * Override this to customize the request.
   *
   * @returns The fetch config for the http request.
   */
  protected requestInit(input: RunAgentInput): RequestInit {
    return {
      method: "POST",
      headers: {
        ...this.headers,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(input),
      signal: this.abortController.signal,
    };
  }

  public runAgent(
    parameters?: RunHttpAgentConfig,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    this.abortController = parameters?.abortController ?? new AbortController();
    return super.runAgent(parameters, subscriber);
  }

  abortRun() {
    this.abortController.abort();
    super.abortRun();
  }

  constructor(config: HttpAgentConfig) {
    super(config);
    this.url = config.url;
    this.headers = structuredClone_(config.headers ?? {});
  }

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
  protected capabilitiesRequestInit(signal?: AbortSignal): RequestInit {
    return {
      method: "GET",
      headers: {
        ...this.headers,
        Accept: "application/json",
      },
      signal,
    };
  }

  async getCapabilities(signal?: AbortSignal): Promise<AgentCapabilities> {
    const url = this.capabilitiesUrl();
    const response = await fetch(url, this.capabilitiesRequestInit(signal));

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
      throw new Error(
        `Invalid capabilities response from ${url}: ${result.error.message}`,
      );
    }
    return result.data;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const httpEvents = runHttpRequest(this.url, this.requestInit(input));
    return transformHttpEventStream(httpEvents, this.debugLogger);
  }

  public clone(): HttpAgent {
    const cloned = super.clone() as HttpAgent;
    cloned.url = this.url;
    cloned.headers = structuredClone_(this.headers ?? {});

    const newController = new AbortController();
    const originalSignal = this.abortController.signal as AbortSignal & { reason?: unknown };
    if (originalSignal.aborted) {
      newController.abort(originalSignal.reason);
    }
    cloned.abortController = newController;

    return cloned;
  }
}
