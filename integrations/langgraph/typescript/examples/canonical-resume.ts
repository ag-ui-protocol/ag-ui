/** Run against an AG-UI HTTP endpoint backed by LangGraph. */
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({
  url: process.env.AG_UI_URL ?? "http://localhost:8000/agent",
});
agent.addMessage({
  id: crypto.randomUUID(),
  role: "user",
  content: "Plan a trip to Mars",
});
await agent.runAgent();

for (const pending of agent.pendingInterrupts) {
  console.log(pending.id, pending.message, pending.metadata?.langgraph);
}

// In a UI, collect an answer for every pending interrupt before running again.
if (agent.pendingInterrupts.length) {
  await agent.runAgent({
    resume: agent.pendingInterrupts.map((pending) => ({
      interruptId: pending.id,
      status: "resolved" as const,
      payload: "The user selected all proposed steps",
    })),
  });
}
