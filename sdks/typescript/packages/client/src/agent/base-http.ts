import { AbstractAgent, RunAgentResult } from "./agent";
import { runHttpRequest } from "@/run/http-request";
import { HttpAgentConfig, RunAgentParameters } from "./types";
import { RunAgentInput, BaseEvent } from "@ag-ui/core";
import { structuredClone_ } from "@/utils";
import { Observable } from "rxjs";
import { AgentSubscriber } from "./subscriber";
import { TransformHttpEventStreamHandlers } from "@/transform/base-type";
import { transformHttpEventStreamFactory } from "@/transform/factory";

interface RunHttpAgentConfig extends RunAgentParameters {
  abortController?: AbortController;
}

export class BaseHttpAgent extends AbstractAgent {
  public url: string;
  public headers: Record<string, string>;
  public abortController: AbortController = new AbortController();
  private httpEventStreamHandlers: TransformHttpEventStreamHandlers[] = [];

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
    this.httpEventStreamHandlers = config.streamHandlers ?? [];
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const httpEvents = runHttpRequest(this.url, this.requestInit(input));
    return transformHttpEventStreamFactory(this.httpEventStreamHandlers)(httpEvents);
  }

  public clone(): BaseHttpAgent {
    const cloned = super.clone() as BaseHttpAgent;
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