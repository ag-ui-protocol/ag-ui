import { AbstractAgent } from "./agent";
import { runHttpRequest, HttpEvent } from "@/run/http-request";
import { HttpAgentConfig, RunAgentParameters } from "./types";
import { RunAgent, RunAgentInput, BaseEvent } from "@ag-ui/core";
import { structuredClone_ } from "@/utils";
import { transformHttpEventStream } from "@/transform/http";
import { Observable } from "rxjs";

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

  public runAgent(parameters?: RunHttpAgentConfig) {
    this.abortController = parameters?.abortController ?? new AbortController();
    return super.runAgent(parameters);
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

  run(input: RunAgentInput): Observable<BaseEvent> {
    const httpEvents = runHttpRequest(this.url, this.requestInit(input));
    return transformHttpEventStream(httpEvents);
  }
}
