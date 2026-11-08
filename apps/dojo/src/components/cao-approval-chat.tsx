"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  CopilotChat,
  useAgent,
  useConfigureSuggestions,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { ApprovalPanel } from "@/components/tool-approval-panel";
import {
  ApprovalSession,
  collectApprovals,
  type ResumeAgent,
  type ResumeHost,
} from "@/tool-approval";

// The Tool Approval chat for the CLI Agent Orchestrator integration only. It
// shows a card for every pending CAO interrupt, sends one resume run once all
// are answered, locks answers that were sent in a failed batch, and shows a
// "Not delivered" notice. The Mastra page is unchanged and does not use it.

const CAO_SUGGESTIONS = [
  {
    title: "Show what the team is waiting on",
    message: "Show me which agents are waiting on an approval.",
  },
  {
    title: "Check pending approvals",
    message: "Check which agents have a pending approval.",
  },
];

export const CaoApprovalChat = () => {
  useConfigureSuggestions({
    suggestions: CAO_SUGGESTIONS,
    available: "always",
  });

  const { copilotkit } = useCopilotKit();
  const { agent } = useAgent({ agentId: "tool_approval", updates: [] });

  // The open interrupts are the agent's own pending interrupts, read after
  // every run. A run that fails leaves them pending (the client refuses any
  // run that does not answer them), so the cards stay until a resume works.
  const [open, setOpen] = useState(() => [...agent.pendingInterrupts]);
  useEffect(() => {
    setOpen([...agent.pendingInterrupts]);
    const subscription = agent.subscribe({
      onRunFinalized: () => setOpen([...agent.pendingInterrupts]),
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  const session = useMemo(
    () =>
      new ApprovalSession(
        copilotkit as unknown as ResumeHost,
        agent as unknown as ResumeAgent,
      ),
    [copilotkit, agent],
  );
  const [answered, setAnswered] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [locked, setLocked] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  // CAO publishes each waiting terminal as a standard interrupt, and answering
  // resumes the run with `{ approved }`.
  const decide = async (id: string, approved: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    setError(null);
    const batch = collectApprovals(undefined, open).flatMap((entry) =>
      entry.id === undefined
        ? []
        : [{ id: entry.id, answerable: !entry.unsupported }],
    );
    const outcome = await session.answer(batch, id, approved);
    busy.current = false;
    setSending(false);
    if (outcome === "locked" || outcome === "blocked") return;
    // The card keeps showing its answer until the whole batch is delivered.
    setAnswered((all) => new Map(all).set(id, approved));
    if (outcome !== "waiting") {
      if (outcome.ok) {
        setAnswered(new Map());
        setLocked(new Map());
      } else {
        // The batch was sent, so CAO may have applied some of it: lock it.
        setLocked(new Map(session.sentAnswers()));
        setError(outcome.message);
      }
    }
  };

  return (
    <div className="flex justify-center items-center h-full w-full">
      <div className="flex flex-col h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <ApprovalPanel
          approvals={collectApprovals(undefined, open)}
          answered={answered}
          locked={locked}
          sending={sending}
          error={error}
          onDecide={decide}
        />
        <CopilotChat
          agentId="tool_approval"
          className="min-h-0 flex-1 rounded-2xl max-w-6xl mx-auto"
        />
      </div>
    </div>
  );
};
