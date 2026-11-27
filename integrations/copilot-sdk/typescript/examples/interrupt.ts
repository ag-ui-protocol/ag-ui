import type { CopilotClientPort } from "../dist/index.js";
import { defineAgent } from "./base.js";

type Args = { topic: string; attendee?: string };
type Answer = { chosen_time?: string; chosen_label?: string; cancelled?: boolean };

/**
 * `schedule_meeting` has no handler, so the runtime suspends it; because it is
 * listed under `interrupts`, the run finishes with an interrupt outcome instead
 * of a plain handoff. The Dojo's picker answers it, and the mapper below turns
 * that answer into the tool result the model reads when the call resumes.
 */
export const createInterruptAgent = (client: CopilotClientPort) =>
  defineAgent(client, {
    agentId: "interrupt",
    description: "Scheduling assistant whose tool pauses for the user to pick a time",
    instructions: `You are a scheduling assistant.

Whenever the user asks you to book a call or schedule a meeting, you MUST call
the \`schedule_meeting\` tool. Pass a short \`topic\` describing the purpose and, if
known, an \`attendee\` describing who the meeting is with.

The tool pauses execution and shows the user a time picker. Once it resumes with
their choice, briefly confirm whether the meeting was scheduled and at what
time, or note that the user cancelled. Do not ask for approval yourself: always
call the tool and let the picker handle the decision. Keep responses short and
friendly.

Never claim a meeting is scheduled unless the tool result says so.`,
    tools: [
      {
        name: "schedule_meeting",
        description: "Ask the user to pick a meeting time, then confirm what was scheduled.",
        parameters: {
          type: "object",
          properties: {
            topic: { type: "string", description: "Short description of the meeting purpose." },
            attendee: { type: "string", description: "Who the meeting is with, if known." },
          },
          required: ["topic"],
        },
      },
    ],
    interrupts: {
      schedule_meeting: (payload, args) => {
        const { topic } = args as Args;
        const answer = (payload ?? {}) as Answer;
        if (answer.cancelled) return `User cancelled. Meeting NOT scheduled: ${topic}`;
        const label = answer.chosen_label ?? answer.chosen_time;
        if (!label) return `User did not pick a time. Meeting NOT scheduled: ${topic}`;
        return `Meeting scheduled for ${label}: ${topic}`;
      },
    },
  });
