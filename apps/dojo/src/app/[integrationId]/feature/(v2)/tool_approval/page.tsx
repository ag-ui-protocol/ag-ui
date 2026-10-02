"use client";
import React, { useState } from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  CopilotChat,
  CopilotChatConfigurationProvider,
  useConfigureSuggestions,
  useInterrupt,
  useRenderTool,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";
import { useTheme } from "next-themes";
import { z } from "zod";

interface ToolApprovalProps {
  params: Promise<{ integrationId: string }>;
}

interface ApprovalRequest {
  toolName?: string;
  args?: { amount?: number; description?: string };
}

// Approval details as the bridge sends them, before the type check.
interface ApprovalPayload extends ApprovalRequest {
  type?: unknown;
}

// The @ag-ui/mastra bridge publishes a pending approval on both channels: the
// standard interrupt (`event.value` is the Interrupt, details under
// `metadata.mastra`) and the legacy on_interrupt event (`event.value` is a JSON
// string). Returns null for any other interrupt so this hook ignores it.
function readApprovalRequest(value: unknown): ApprovalRequest | null {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const standard = (parsed as { metadata?: { mastra?: ApprovalPayload } })
    .metadata?.mastra;
  const request = standard ?? (parsed as ApprovalPayload);
  if (request.type !== "mastra_tool_approval") return null;
  return { toolName: request.toolName, args: request.args };
}

// Shape of the `record_expense` tool result once the approved call has run.
interface ExpenseRecord {
  expenseId?: string;
  amount?: number;
  description?: string;
  status?: string;
}

const ToolApproval: React.FC<ToolApprovalProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="tool_approval"
    >
      <CopilotChatConfigurationProvider agentId="tool_approval">
        <ChatContent />
      </CopilotChatConfigurationProvider>
    </CopilotKit>
  );
};

const ChatContent = () => {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Record a team dinner",
        message: "Record a $250 expense for the team dinner.",
      },
      {
        title: "Log a taxi ride",
        message: "Log a $42 taxi ride to the airport as an expense.",
      },
    ],
    available: "always",
  });

  // The paused call waits in Mastra's storage. Approve and Reject both resolve
  // the interrupt, so the bridge hands the decision to Mastra's own
  // approveToolCall / declineToolCall for the original call.
  useInterrupt({
    agentId: "tool_approval",
    renderInChat: true,
    enabled: (event) => readApprovalRequest(event.value) !== null,
    render: ({ event, resolve }) => {
      const request = readApprovalRequest(event.value) ?? {};
      return (
        <ApprovalCard
          toolName={request.toolName ?? "tool"}
          amount={request.args?.amount}
          description={request.args?.description}
          onApprove={() => resolve({ approved: true })}
          onReject={() => resolve({ approved: false })}
        />
      );
    },
  });

  // Renders the original call once the resumed run delivers its result.
  useRenderTool({
    name: "record_expense",
    parameters: z.object({
      amount: z.number().optional(),
      description: z.string().optional(),
    }),
    render: ({ parameters, result, status }) => {
      if (status !== "complete") {
        return (
          <div className="rounded-lg border border-gray-200 p-3 text-sm">
            Recording {parameters?.description ?? "expense"}...
          </div>
        );
      }
      let parsed: unknown = result;
      if (typeof parsed === "string") {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          // Mastra reports a declined call as a plain string result.
        }
      }
      const record =
        parsed && typeof parsed === "object" ? (parsed as ExpenseRecord) : null;
      if (!record?.expenseId) {
        return (
          <div
            data-testid="expense-declined"
            className="rounded-lg border border-gray-200 p-3 text-sm"
          >
            Expense not recorded: {String(parsed ?? "no result")}
          </div>
        );
      }
      return (
        <div
          data-testid="expense-recorded"
          className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
        >
          <div className="font-semibold" data-testid="expense-id">
            {record.expenseId}
          </div>
          <div>
            ${record.amount} for {record.description} ({record.status})
          </div>
        </div>
      );
    },
  });

  return (
    <div className="flex justify-center items-center h-full w-full">
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          agentId="tool_approval"
          className="h-full rounded-2xl max-w-6xl mx-auto"
        />
      </div>
    </div>
  );
};

const ApprovalCard: React.FC<{
  toolName: string;
  amount?: number;
  description?: string;
  onApprove: () => void;
  onReject: () => void;
}> = ({ toolName, amount, description, onApprove, onReject }) => {
  const { theme } = useTheme();
  const [decided, setDecided] = useState(false);
  const dark = theme === "dark";

  // Blank on click: the resumed run's tool result and the agent's reply become
  // the record, and this prevents a second decision.
  if (decided) return null;

  const decide = (action: () => void) => () => {
    setDecided(true);
    action();
  };

  return (
    <div
      data-testid="approval-card"
      className={`rounded-xl w-[420px] p-5 shadow-lg ${
        dark
          ? "bg-slate-800 text-white border border-slate-700"
          : "bg-white text-gray-800 border border-gray-200"
      }`}
    >
      <p className="text-xs uppercase tracking-wide opacity-60 mb-1">
        Approval required
      </p>
      <h2 className="text-lg font-semibold mb-1">
        <code>{toolName}</code>
      </h2>
      <p className="text-sm mb-4" data-testid="approval-args">
        {amount !== undefined ? `$${amount}` : "An expense"}
        {description ? ` for ${description}` : ""}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="approval-approve"
          onClick={decide(onApprove)}
          className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
        >
          Approve
        </button>
        <button
          type="button"
          data-testid="approval-reject"
          onClick={decide(onReject)}
          className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
            dark
              ? "border-slate-600 hover:bg-slate-700"
              : "border-gray-200 hover:bg-gray-50"
          }`}
        >
          Reject
        </button>
      </div>
    </div>
  );
};

export default ToolApproval;
