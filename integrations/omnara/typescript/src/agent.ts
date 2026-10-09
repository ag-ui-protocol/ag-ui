import { AbstractAgent } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";
import { createOmnaraApi, type OmnaraApi } from "./api";
import { OmnaraRun } from "./run";
import type {
  BackendTool,
  OmnaraAgentConfig,
  OmnaraErrorContext,
} from "./types";

/**
 * An AG-UI agent backed by an Omnara agent. Each AG-UI thread gets its own
 * Omnara agent (per user), launched from a profile or an inline definition.
 * Omnara's log is the truth; each run restates the chat from it.
 */
export class OmnaraAgent extends AbstractAgent {
  private config: OmnaraAgentConfig;
  private api: OmnaraApi;
  private backendTools: Map<string, BackendTool>;
  private currentRun: OmnaraRun | null = null;

  /** `api` replaces the Omnara client (tests). */
  constructor(config: OmnaraAgentConfig, api?: OmnaraApi) {
    super(config);
    if (Boolean(config.profile) === Boolean(config.definition)) {
      throw new Error(
        "OmnaraAgent: give exactly one of `profile` and `definition`",
      );
    }
    if (!config.user || (config.user !== "anonymous" && !config.user.id)) {
      throw new Error(
        'OmnaraAgent: `user` is required (an `{ id }` from your auth, or "anonymous")',
      );
    }
    this.config = config;
    this.backendTools = new Map(
      (config.backendTools ?? []).map((t) => [t.name, t]),
    );
    if (api) {
      this.api = api;
    } else {
      const apiKey = config.apiKey ?? process.env.OMNARA_API_KEY;
      if (!apiKey)
        throw new Error("OmnaraAgent: set `apiKey` or OMNARA_API_KEY");
      this.api = createOmnaraApi({
        apiKey,
        orgId: config.orgId,
        projectId: config.projectId,
        baseUrl: config.baseUrl,
      });
    }
  }

  /** `super.clone()` keeps the AbstractAgent state; the Omnara client is shared. */
  public clone(): OmnaraAgent {
    const cloned = super.clone() as OmnaraAgent;
    cloned.config = this.config;
    cloned.api = this.api;
    cloned.backendTools = this.backendTools;
    cloned.currentRun = null;
    return cloned;
  }

  /** Stop: cancels the agent's current work and its running subagents, and ends the run as cancelled. */
  public abortRun(): void {
    this.currentRun?.stop();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const run = new OmnaraRun(
        {
          api: this.api,
          config: this.config,
          backendTools: this.backendTools,
          report: (error, context) => this.report(error, context),
        },
        input,
        (event) => subscriber.next(event),
      );
      this.currentRun = run;
      run
        .execute()
        .catch((error) =>
          this.report(error, { operation: "run", threadId: input.threadId }),
        )
        .finally(() => {
          if (this.currentRun === run) this.currentRun = null;
          subscriber.complete();
        });
      // Unsubscribing (a closed tab) never cancels the Omnara agent.
      return () => run.detach();
    });
  }

  private async report(
    error: unknown,
    context: OmnaraErrorContext,
  ): Promise<void> {
    try {
      if (this.config.onError) await this.config.onError(error, context);
      else console.error(`[@ag-ui/omnara] ${context.operation}`, error);
    } catch {
      // A broken hook must not break the run.
    }
  }
}
