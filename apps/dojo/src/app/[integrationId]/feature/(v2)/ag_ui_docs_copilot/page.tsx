"use client";

import React from "react";
import { CopilotKit } from "@copilotkit/react-core";
import {
  CopilotChat,
  useConfigureSuggestions,
  useRenderTool,
} from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { z } from "zod";

interface AGUIDocsCopilotProps {
  params: Promise<{ integrationId: string }>;
}

const AGUIDocsCopilot: React.FC<AGUIDocsCopilotProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="ag_ui_docs_copilot"
    >
      <DocsChat />
    </CopilotKit>
  );
};

const DocsChat = () => {
  useRenderTool({
    name: "ask_ag_ui_openai_agents_docs",
    agentId: "ag_ui_docs_copilot",
    parameters: z.object({ input: z.string().optional() }),
    render: ({ status, args, result }: any) => (
      <DocsLookupProgress
        source="AG-UI OpenAI Agents"
        status={status}
        query={args?.input}
        result={result}
      />
    ),
  });
  useRenderTool({
    name: "ask_ag_ui_protocol_docs",
    agentId: "ag_ui_docs_copilot",
    parameters: z.object({ input: z.string().optional() }),
    render: ({ status, args, result }: any) => (
      <DocsLookupProgress
        source="AG-UI Protocol"
        status={status}
        query={args?.input}
        result={result}
      />
    ),
  });

  useConfigureSuggestions({
    suggestions: [
      {
        title: "Stream an existing agent",
        message:
          "Show me how to transfer an existing OpenAI Agents SDK streaming run to AG-UI. Give the smallest FastAPI endpoint using AGUITranslator.to_openai(), Runner.run_streamed(), AGUITranslator.to_agui(), EventEncoder, and StreamingResponse. Explain only the data flow at each boundary.",
      },
      {
        title: "Map SDK events to AG-UI",
        message:
          "Give me one concise table that maps OpenAI Agents SDK streaming events and items to AG-UI events. Include run lifecycle, text messages, tool calls and results, reasoning, state snapshots, messages snapshots, and errors. Include only mappings supported by this integration.",
      },
      {
        title: "Choose an integration layer",
        message:
          "Compare the three integration APIs: AGUITranslator, OpenAIAgentsAgent, and add_openai_agents_fastapi_endpoint. Give one concise table with what each does, when to choose it, and how much control it keeps over the SDK agent and server.",
      },
    ],
    available: "always",
  });

  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="h-full w-full rounded-lg md:h-8/10 md:w-8/10">
        <CopilotChat
          agentId="ag_ui_docs_copilot"
          className="mx-auto h-full max-w-5xl rounded-2xl"
        />
      </div>
    </div>
  );
};

function DocsLookupProgress({
  source,
  status,
  query,
  result,
}: {
  source: "AG-UI OpenAI Agents" | "AG-UI Protocol";
  status: "inProgress" | "executing" | "complete";
  query?: string;
  result?: string;
}) {
  const complete = status === "complete";
  const step = complete
    ? "Answer ready"
    : status === "executing"
      ? "Finding the relevant section"
      : `Opening the ${source} guide`;

  return (
    <div className="my-2 max-w-md rounded-xl border border-blue-200/70 bg-blue-50/70 px-4 py-3 text-sm dark:border-blue-400/20 dark:bg-blue-950/30">
      <div className="flex items-center gap-2 font-medium text-blue-900 dark:text-blue-100">
        <span className={complete ? "" : "animate-pulse"}>
          {complete ? "✓" : "📚"}
        </span>
        <span>
          {complete ? `${source} docs consulted` : `Consulting ${source} docs`}
        </span>
        {!complete && (
          <span
            className="ml-auto flex gap-0.5"
            aria-label="Docs search in progress"
          >
            <span className="animate-bounce">•</span>
            <span className="animate-bounce [animation-delay:120ms]">•</span>
            <span className="animate-bounce [animation-delay:240ms]">•</span>
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-blue-800/70 dark:text-blue-200/70">
        {step}
      </div>
      {!complete && query && (
        <div className="mt-2 line-clamp-2 text-xs text-blue-900/70 dark:text-blue-100/70">
          {query}
        </div>
      )}
      {complete && result && (
        <div className="mt-1 line-clamp-2 text-xs text-blue-900/70 dark:text-blue-100/70">
          {source} specialist finished.
        </div>
      )}
    </div>
  );
}

export default AGUIDocsCopilot;
