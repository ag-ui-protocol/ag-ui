import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { recordExpenseTool } from "../tools";
import { getStorage } from "../storage";

// Mastra's native tool approval bridged onto AG-UI interrupts. `record_expense`
// sets `requireApproval: true`, so Mastra pauses the call and keeps it pending
// in storage until the user approves or rejects it in the chat.
export const toolApprovalAgent = new Agent({
  id: "tool_approval",
  name: "tool_approval",
  instructions: `You are an expense assistant. Whenever the user asks you to record, log, or file an expense, you MUST call the \`record_expense\` tool with the \`amount\` in US dollars and a short \`description\`.

The tool asks the user to approve the call before it runs. Do not ask for confirmation yourself. After the tool returns, confirm the recorded expense id in one short sentence, or, if the call was not approved, say that the expense was not recorded.`,
  model: "openai/gpt-4.1-mini",
  tools: { record_expense: recordExpenseTool },
  memory: new Memory({
    storage: getStorage(),
  }),
});
