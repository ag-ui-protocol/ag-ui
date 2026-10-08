import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// Backend tool gated by Mastra's native approval (`requireApproval: true`).
// Mastra pauses before `execute` runs and streams `tool-call-approval`; the
// @ag-ui/mastra bridge surfaces that as an interrupt, CopilotKit's v2
// `useInterrupt` renders Approve / Reject, and the bridge completes the pending
// call through Mastra's approval. The result is built from the approved args so
// the UI can tell a real execution apart.
export const recordExpenseTool = createTool({
  id: "record-expense",
  description:
    "Record a business expense in the ledger. Requires the user's approval " +
    "before it runs.",
  inputSchema: z.object({
    amount: z.number().describe("Expense amount in US dollars"),
    description: z.string().describe("What the expense was for"),
  }),
  requireApproval: true,
  execute: async ({ amount, description }) => ({
    expenseId: `EXP-${Math.round(amount * 100)}`,
    amount,
    description,
    status: "recorded",
  }),
});
