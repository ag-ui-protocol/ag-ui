import type { LLMock, ChatMessage, ChatCompletionRequest } from "@copilotkit/aimock";

const textOf = (content: ChatMessage["content"] | undefined): string =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.map((part) => part.type === "text" ? part.text : "").join("") : "";
const systemText = (req: ChatCompletionRequest) =>
  req.messages.filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n");
const call = (name: string, args: object) => ({
  toolCalls: [{ name, arguments: JSON.stringify(args) }],
});

/** Register LAST in registerLLMockFixtures: prepend beats the generic tool-result acknowledgment. */
export function registerCopilotSdkSubgraphsFixtures(mockServer: LLMock): void {
  mockServer.prependFixture({
    match: {
      endpoint: "chat",
      predicate: (req: ChatCompletionRequest) =>
        /Copilot SDK travel (supervisor|specialist:)/.test(systemText(req)),
    },
    response: (req: ChatCompletionRequest) => {
      const specialist = systemText(req).match(/Copilot SDK travel specialist: (flights|hotels|experiences)\./)?.[1];
      const results = req.messages.filter((message) => message.role === "tool");
      if (!specialist) {
        const agent = ["flights", "hotels", "experiences"][results.length];
        return agent ? call("task", {
          agent_type: `${agent}_agent`, name: agent, description: `Plan ${agent}`,
          prompt: `Plan ${agent} for the Amsterdam to San Francisco demo.`, mode: "sync",
        }) : { content: "Your demo itinerary is ready: your chosen flight, hotel, and four experiences. Nothing has been booked." };
      }
      if (!results.length) return call("travel_state", { agent: specialist });
      // The real backend generates options and validates selections; the mock only chooses the next model action.
      const result = JSON.parse(textOf(results.at(-1)?.content));
      if (result.saved || result.experiences) {
        return { content: result.saved ? `Selected ${result.selection}.` : "Enjoy Pier 39, Golden Gate Bridge, Swan Oyster Depot, and Tartine Bakery." };
      }
      return result.selection ? call("travel_state", result) : call("choose_travel_option", result);
    },
  });
}
