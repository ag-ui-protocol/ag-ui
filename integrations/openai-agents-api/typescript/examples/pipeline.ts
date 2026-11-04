/**
 * Multi-agent: a researcher → analyst → writer pipeline. Each stage is its own
 * Agents API session (one per thread and stage, so follow-ups keep context),
 * driven through OpenAIAgentsAgent. The pipeline publishes each stage as a
 * STEP_STARTED / STEP_FINISHED pair named `agent:<id>` and each hand-over as a
 * `MultiAgentHandoff` custom event, and streams every stage's text into the chat.
 */

import { AbstractAgent } from "@ag-ui/client";
import {
  EventType,
  type BaseEvent,
  type Message,
  type RunAgentInput,
} from "@ag-ui/core";
import type OpenAI from "openai";
import { Observable } from "rxjs";
import { OpenAIAgentsAgent } from "../src";

interface Stage {
  id: string;
  instructions: string;
  /** Turns the previous stage's output (or the user's request) into this stage's input. */
  prompt: (input: string) => string;
}

const STAGES: Stage[] = [
  {
    id: "researcher",
    instructions: `You are the RESEARCHER in a three-agent pipeline. Gather the key facts for the user's topic.
Reply with 2-3 short bullet points of findings and nothing else. Begin every bullet with the exact prefix "Research:".`,
    prompt: (request) => request,
  },
  {
    id: "analyst",
    instructions: `You are the ANALYST in a three-agent pipeline. You receive the researcher's findings. Draw out what they imply.
Reply with 2-3 short bullet points of analysis and nothing else. Begin every bullet with the exact prefix "Analysis:".`,
    prompt: (findings) => `The researcher's findings:\n${findings}`,
  },
  {
    id: "writer",
    instructions: `You are the WRITER in a three-agent pipeline. You receive the analyst's conclusions. Write the final answer for the user.
Reply with one short paragraph and nothing else. Begin your reply with the exact prefix "Summary:".`,
    prompt: (analysis) => `The analyst's conclusions:\n${analysis}`,
  },
];

const textOf = (message: Message | undefined): string => {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: { type: string; text?: string }) =>
        "text" in part && typeof part.text === "string" ? part.text : "",
      )
      .join(" ");
  }
  return "";
};

export class PipelineAgent extends AbstractAgent {
  private stages: Array<{ stage: Stage; agent: OpenAIAgentsAgent }>;

  constructor(options: { model: string; client?: OpenAI }) {
    super();
    this.stages = STAGES.map((stage) => ({
      stage,
      agent: new OpenAIAgentsAgent({
        ...(options.client ? { client: options.client } : {}),
        agent: {
          model: options.model,
          instructions: stage.instructions,
          reasoning: { effort: "low" },
        },
        forwardState: false,
      }),
    }));
  }

  public clone(): PipelineAgent {
    const cloned = super.clone() as PipelineAgent;
    cloned.stages = this.stages;
    return cloned;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let active: { unsubscribe(): void } | undefined;
      let cancelled = false;

      const runStage = (stage: Stage, agent: OpenAIAgentsAgent, text: string) =>
        new Promise<{ output: string; error?: BaseEvent }>(
          (resolve, reject) => {
            let output = "";
            let error: BaseEvent | undefined;
            active = agent
              .run({
                ...input,
                threadId: `${input.threadId}:${stage.id}`,
                runId: `${input.runId}:${stage.id}`,
                messages: [
                  {
                    id: `${input.runId}:${stage.id}`,
                    role: "user",
                    content: stage.prompt(text),
                  },
                ],
                tools: [],
                context: [],
                state: {},
              })
              .subscribe({
                next: (event) => {
                  if (
                    event.type === EventType.RUN_STARTED ||
                    event.type === EventType.RUN_FINISHED
                  )
                    return;
                  if (event.type === EventType.RUN_ERROR) {
                    error = event;
                    return;
                  }
                  if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
                    output += (event as unknown as { delta: string }).delta;
                  }
                  subscriber.next(event);
                },
                error: reject,
                complete: () => resolve({ output, error }),
              });
          },
        );

      const execute = async () => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
        const request = textOf(
          [...input.messages]
            .reverse()
            .find((message) => message.role === "user"),
        );
        let carried = request;
        for (let index = 0; index < this.stages.length; index++) {
          const { stage, agent } = this.stages[index];
          if (cancelled) return;
          subscriber.next({
            type: EventType.STEP_STARTED,
            stepName: `agent:${stage.id}`,
          } as BaseEvent);
          const { output, error } = await runStage(stage, agent, carried);
          if (error) {
            subscriber.next({
              type: EventType.CUSTOM,
              name: "MultiAgentNodeStatus",
              value: { node_id: stage.id, status: "failed" },
            } as BaseEvent);
            subscriber.next({
              type: EventType.STEP_FINISHED,
              stepName: `agent:${stage.id}`,
            } as BaseEvent);
            subscriber.next(error);
            return;
          }
          subscriber.next({
            type: EventType.STEP_FINISHED,
            stepName: `agent:${stage.id}`,
          } as BaseEvent);
          const next = this.stages[index + 1];
          if (next) {
            subscriber.next({
              type: EventType.CUSTOM,
              name: "MultiAgentHandoff",
              value: { from_nodes: [stage.id], to_nodes: [next.stage.id] },
            } as BaseEvent);
          }
          carried = output;
        }
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
      };

      execute().then(
        () => subscriber.complete(),
        (error) => subscriber.error(error),
      );
      return () => {
        cancelled = true;
        active?.unsubscribe();
      };
    });
  }
}
