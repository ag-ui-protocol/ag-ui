import type { Interrupt, ResumeEntry } from "@ag-ui/core";
import type { AgentInteraction, InteractionAnswer } from "./api";

// Omnara's approvals and questions as AG-UI interrupts, and the resume payload
// back to Omnara's answers.

const PERMISSION_SCHEMA = {
  type: "object",
  properties: { approved: { type: "boolean" }, reason: { type: "string" } },
  required: ["approved"],
};
const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      description: "One entry per question, in order.",
      items: {
        type: "object",
        properties: {
          optionIndices: { type: "array", items: { type: "integer" } },
          text: { type: "string" },
        },
        required: ["optionIndices"],
      },
    },
  },
  required: ["answers"],
};
const DISMISSED = "The user dismissed this without answering.";

export function toInterrupt(interaction: AgentInteraction): Interrupt {
  const permission = interaction.interaction_kind === "permission";
  return {
    id: interaction.id,
    reason: permission ? "omnara:permission" : "omnara:question",
    message: interaction.request.title,
    toolCallId: interaction.tool_call_id,
    responseSchema: permission ? PERMISSION_SCHEMA : QUESTION_SCHEMA,
    metadata: {
      omnara: {
        kind: interaction.interaction_kind,
        agentId: interaction.agent_id,
        agentName: interaction.agent_name,
        toolName: interaction.tool_name,
        form: interaction.request,
      },
    },
  };
}

/**
 * Resume payload to Omnara answers. A dismissed card still lets the agent
 * continue: a permission is denied, a question gets its "Other" option.
 */
export function answersFor(
  interaction: AgentInteraction,
  entry: ResumeEntry,
): InteractionAnswer[] {
  const payload = (entry.payload ?? {}) as {
    approved?: boolean;
    reason?: string;
    answers?: Array<{ optionIndices?: number[]; text?: string }>;
  };
  if (interaction.interaction_kind === "permission") {
    if (entry.status === "resolved" && payload.approved === true)
      return [{ option_indices: [0] }];
    const reason = entry.status === "cancelled" ? DISMISSED : payload.reason;
    return [{ option_indices: [1], ...(reason ? { text: reason } : {}) }];
  }
  return interaction.request.questions.map((question, i) => {
    if (entry.status === "resolved") {
      const answer = payload.answers?.[i];
      return {
        option_indices: answer?.optionIndices ?? [],
        ...(answer?.text ? { text: answer.text } : {}),
      };
    }
    const other = question.options.findIndex((o) => o.allows_text);
    return {
      option_indices: [other >= 0 ? other : question.options.length - 1],
      text: DISMISSED,
    };
  });
}
