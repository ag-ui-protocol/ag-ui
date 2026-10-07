import type { CopilotClientPort } from "../dist/index.js";
import { defineAgent } from "./base.js";

/**
 * The supervisor delegates through the runtime's built-in `task` tool to a
 * custom agent. The subagent's `request_human_approval` call is suspended and
 * surfaced as an interrupt (tagged with the subagent's run id); the user's
 * decision resumes it on the next run.
 */
export const createDeepagentsSubagentsAgent = (client: CopilotClientPort) =>
  defineAgent(client, {
    agentId: "deepagents_subagents",
    description: "Research supervisor whose subagent pauses for approval",
    instructions: `You are a research supervisor with one specialist subagent: \`research_assistant\`.

For EVERY user question you MUST delegate to it: call the \`task\` tool once with \`agent_type="research_assistant"\` and pass the user's question as the description and prompt. Do not answer from your own knowledge. Once the subagent returns, relay its final answer to the user in one short paragraph.`,
    tools: [
      {
        name: "request_human_approval",
        description:
          "Request the user's approval before finalizing your answer. Pass a one- or " +
          "two-sentence summary of the answer you intend to give. Returns the user's decision.",
        parameters: {
          type: "object",
          properties: { answer_summary: { type: "string" } },
          required: ["answer_summary"],
        },
      },
    ],
    interrupts: {
      request_human_approval: (payload) =>
        (payload as { approved?: boolean })?.approved
          ? "The user APPROVED. Present the answer as your final answer."
          : "The user REJECTED the answer. Do NOT present it. Start your reply with " +
            "'You rejected my draft answer.' and offer to revise it.",
    },
    sessionConfig: {
      customAgents: [
        {
          name: "research_assistant",
          displayName: "Research assistant",
          description:
            "Researches the user's question and MUST get human approval before finalizing its answer.",
          tools: ["request_human_approval"],
          prompt:
            "You are a research assistant. When given a question:\n" +
            "1. Decide on a concise (2-3 sentence) answer.\n" +
            "2. You MUST call the `request_human_approval` tool exactly once, passing " +
            "a short summary of that intended answer, and wait for the decision.\n" +
            "3. Follow the tool result's instruction exactly: on approval give the " +
            "final answer; on rejection do NOT give the answer — begin with 'You " +
            "rejected my draft answer.' and offer to revise.\n" +
            "NEVER give a final answer without first calling `request_human_approval`.",
        },
      ],
    },
  });
