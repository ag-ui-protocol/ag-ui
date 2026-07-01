import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { getStorage } from "../storage";

// An agent with Mastra Observational Memory (OM) enabled. OM is the developer's
// own opt-in: the Observer/Reflector agents run out of band, read the growing
// conversation, compress it into observations, and activate those into the
// context window. Mastra streams that background work on `fullStream` as
// `data-om-*` chunks; the AG-UI Mastra bridge maps them to ACTIVITY_SNAPSHOT /
// ACTIVITY_DELTA events (activityType "mastra-observational-memory") when the
// bridge's `observationalMemory` toggle is on (see src/agents.ts).
//
// The thresholds below are deliberately LOW so the demo triggers observation /
// buffering / activation within a few short turns instead of needing tens of
// thousands of tokens. A production agent would use much larger windows.
export const observationalMemoryAgent = new Agent({
  id: "observational_memory",
  name: "observational_memory",
  instructions: `
    You are a friendly assistant with long-term observational memory.

    Just chat naturally with the user. As the conversation grows, your memory
    system observes it in the background and compresses older turns into
    durable observations — you do not need to do anything special for that to
    happen. Keep your replies short and conversational.
  `,
  model: "openai/gpt-4.1-mini",
  memory: new Memory({
    storage: getStorage(),
    options: {
      observationalMemory: {
        // Use the same provider as the main model so a single key drives the
        // whole demo. OM's default is google/gemini-2.5-flash.
        model: "openai/gpt-4.1-mini",
        scope: "thread",
        observation: {
          // Low thresholds so the Observer fires after a few short turns. Async
          // buffering (bufferTokens) makes the Observer run in the background
          // and reliably surface a buffering activity within ~2 turns; its
          // completion/activation is delivered out of band (same nuance as
          // background tasks), so the in-turn card reads "Working".
          messageTokens: 600,
          bufferTokens: 300,
        },
        reflection: {
          observationTokens: 1_500,
        },
      },
    },
  }),
});
