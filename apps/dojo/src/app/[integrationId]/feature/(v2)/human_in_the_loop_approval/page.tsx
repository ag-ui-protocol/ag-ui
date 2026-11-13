"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  CopilotChat,
  useConfigureSuggestions,
  useInterrupt,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";

interface ApprovalProps {
  params: Promise<{ integrationId: string }>;
}

interface ApprovalRequest {
  id: string;
  toolName: string;
  toolInput: unknown;
}

// The adapter publishes a paused `needs_approval` call as a standard AG-UI
// interrupt on RUN_FINISHED: `event.value` is the Interrupt, with
// `reason: "tool_approval"` and the call under `metadata.tool_name` /
// `metadata.tool_input`. Returns null for any other interrupt so this hook
// ignores it.
function readApprovalRequest(value: unknown): ApprovalRequest | null {
  if (!value || typeof value !== "object") return null;
  const interrupt = value as {
    id?: unknown;
    reason?: string;
    metadata?: { tool_name?: unknown; tool_input?: unknown };
  };
  const toolName = interrupt.metadata?.tool_name;
  if (
    interrupt.reason !== "tool_approval" ||
    typeof interrupt.id !== "string" ||
    typeof toolName !== "string"
  ) {
    return null;
  }
  return {
    id: interrupt.id,
    toolName,
    toolInput: interrupt.metadata?.tool_input ?? {},
  };
}

const Approval: React.FC<ApprovalProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="human_in_the_loop_approval"
    >
      <Chat />
    </CopilotKit>
  );
};

const Chat = () => {
  useConfigureSuggestions({
    suggestions: [
      { title: "Refund an order", message: "I'd like a refund for ORD-1001." },
      { title: "Refund another order", message: "Please refund ORD-1002." },
      { title: "Unknown order", message: "Can you refund ORD-9999?" },
    ],
    available: "always",
    consumerAgentId: "human_in_the_loop_approval",
  });

  // Resolving sends the decision as the next run's `resume` entry. The
  // backend answers the paused call from the conversation history before the
  // model runs: approved, the refund runs; rejected, it does not.
  useInterrupt({
    agentId: "human_in_the_loop_approval",
    renderInChat: true,
    enabled: (event) => readApprovalRequest(event.value) !== null,
    render: ({ event, resolve }) => {
      const request = readApprovalRequest(event.value);
      if (!request) return <></>;
      // Answer this interrupt by id: CopilotKit resumes once every open
      // interrupt has an answer. The demo agent makes one call per turn.
      return (
        <ApprovalCard
          request={request}
          onApprove={() => resolve({ approved: true }, request.id)}
          onReject={() => resolve({ approved: false }, request.id)}
        />
      );
    },
  });

  return (
    <div className="flex flex-col justify-center items-center h-full w-full gap-4">
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          agentId="human_in_the_loop_approval"
          className="h-full rounded-2xl max-w-6xl mx-auto"
        />
      </div>
    </div>
  );
};

function ApprovalCard({
  request,
  onApprove,
  onReject,
}: {
  request: ApprovalRequest;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div
      data-testid="approval-card"
      className="rounded-xl w-[500px] max-w-full p-6 shadow-lg border border-gray-200/80 bg-white dark:border-white/15 dark:bg-gray-900"
    >
      <h2 className="text-lg font-bold mb-2">Approval needed</h2>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        The agent wants to call{" "}
        <code className="font-mono">{request.toolName}</code> with:
      </p>
      <pre className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-xs mb-4 overflow-x-auto">
        {JSON.stringify(request.toolInput, null, 2)}
      </pre>
      <div className="flex justify-center gap-4">
        <button
          type="button"
          data-testid="reject-button"
          onClick={onReject}
          className="px-6 py-2 rounded-lg font-semibold bg-gray-100 hover:bg-gray-200 text-gray-800 border border-gray-300 dark:bg-gray-800 dark:hover:bg-gray-700 dark:text-gray-100 dark:border-gray-600"
        >
          Reject
        </button>
        <button
          type="button"
          data-testid="approve-button"
          onClick={onApprove}
          className="px-6 py-2 rounded-lg font-semibold bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white"
        >
          Approve
        </button>
      </div>
    </div>
  );
}

export default Approval;
