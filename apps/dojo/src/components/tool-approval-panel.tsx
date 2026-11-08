import React from "react";
import { useTheme } from "next-themes";
import type { PendingApproval } from "@/tool-approval";

// The approval cards for every open interrupt, plus the alert for a decision
// that was not delivered. The page owns the state: the cards render from the
// agent's pending interrupts, so a failed decision leaves them in place. With
// several interrupts every card stays until the whole batch is delivered. An
// answered card shows its answer and can still be changed, until the batch has
// been sent: after that the answer is locked, because it may already have
// reached the agent, and the card offers a retry of the same answer only.
export const ApprovalPanel: React.FC<{
  approvals: PendingApproval[];
  // Answers recorded so far (true = approved), for a batch still waiting on
  // other interrupts or on a retry.
  answered: ReadonlyMap<string, boolean>;
  // Answers already sent in a batch that failed (true = approved). Locked.
  locked: ReadonlyMap<string, boolean>;
  sending: boolean;
  error: string | null;
  onDecide: (id: string, approved: boolean) => void;
}> = ({ approvals, answered, locked, sending, error, onDecide }) => (
  <div className="flex flex-col items-center gap-2 py-2">
    {error && (
      <div
        role="alert"
        data-testid="approval-error"
        className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
      >
        Not delivered: {error}. The approval card is still here. Answers that
        were already sent are locked; try again to resend them.
      </div>
    )}
    {approvals.some((approval) => approval.unsupported) && (
      <div
        role="alert"
        data-testid="approval-blocked"
        className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
      >
        This page can&apos;t answer every pending request, so it can&apos;t send
        this batch and sends no answer. Answer the unsupported request where it
        was raised.
      </div>
    )}
    {approvals.map(({ id, request, generic, unsupported, schema }) => (
      <ApprovalCard
        key={id ?? "primary"}
        toolName={request.toolName ?? "tool"}
        amount={request.args?.amount}
        description={request.args?.description}
        cao={request.cao}
        note={generic ? `Interrupt ${id ?? ""}` : undefined}
        answer={
          id === undefined ? undefined : (locked.get(id) ?? answered.get(id))
        }
        locked={id !== undefined && locked.has(id)}
        unsupported={unsupported}
        schema={schema}
        disabled={sending || approvals.some((approval) => approval.unsupported)}
        onApprove={() => id !== undefined && onDecide(id, true)}
        onReject={() => id !== undefined && onDecide(id, false)}
      />
    ))}
  </div>
);

export const ApprovalCard: React.FC<{
  toolName: string;
  amount?: number;
  description?: string;
  cao?: { provider: string; terminalId: string };
  // For an interrupt the page does not recognise: what to show instead.
  note?: string;
  // The answer recorded for this card, if any.
  answer?: boolean;
  // The answer was sent in a failed batch: it cannot change, only be retried.
  locked?: boolean;
  // This page cannot answer the request: no buttons, show what it expects.
  unsupported?: boolean;
  schema?: string;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}> = ({
  toolName,
  amount,
  description,
  cao,
  note,
  answer,
  locked,
  unsupported,
  schema,
  disabled,
  onApprove,
  onReject,
}) => {
  const { theme } = useTheme();
  const dark = theme === "dark";

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
        {note ? (
          note
        ) : cao ? (
          <>
            {cao.provider} in terminal <code>{cao.terminalId}</code>
          </>
        ) : (
          <>
            {amount !== undefined ? `$${amount}` : "An expense"}
            {description ? ` for ${description}` : ""}
          </>
        )}
      </p>
      {unsupported && (
        <div className="text-sm mb-2" data-testid="approval-unsupported">
          <p>This page can&apos;t answer this kind of request.</p>
          <p className="opacity-70">Expected answer:</p>
          <pre className="text-xs overflow-auto max-h-40">
            {schema ?? "no response schema given"}
          </pre>
        </div>
      )}
      {answer !== undefined && (
        <p className="text-sm mb-2" data-testid="approval-answer">
          {locked
            ? `${answer ? "Approve" : "Reject"} sent; it may already have reached the agent. Retrying sends the same answer.`
            : `${answer ? "Approved" : "Rejected"}: waiting to send with the other answers. You can still change it.`}
        </p>
      )}
      {!unsupported && (
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="approval-approve"
            disabled={disabled || (locked && answer === false)}
            onClick={onApprove}
            className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {locked && answer === true ? "Retry: Approve" : "Approve"}
          </button>
          <button
            type="button"
            data-testid="approval-reject"
            disabled={disabled || (locked && answer === true)}
            onClick={onReject}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50 ${
              dark
                ? "border-slate-600 hover:bg-slate-700"
                : "border-gray-200 hover:bg-gray-50"
            }`}
          >
            {locked && answer === false ? "Retry: Reject" : "Reject"}
          </button>
        </div>
      )}
    </div>
  );
};
