import type { LLMock } from "@copilotkit/aimock";
import { textOf } from "./lib/fixture-message-text";

// The SDK only executes its advertised, fully qualified MCP name. Keep this
// ahead of the shared bare get_weather fixture used by other integrations.
export function registerClaudeSdkWeatherFixtures(server: LLMock) {
  server.addFixture({
    match: {
      predicate: (request) =>
        request.messages.at(-1)?.role !== "tool" &&
        !!request.tools?.some(
          (tool) => tool.function.name === "mcp__weather__get_weather",
        ) &&
        /weather/i.test(
          textOf(
            request.messages.filter((message) => message.role === "user").at(-1)
              ?.content,
          ),
        ),
    },
    response: (request) => {
      const users = request.messages.filter(
        (message) => message.role === "user",
      );
      const city = /\b(San Francisco|New York|Tokyo)\b/i.exec(
        textOf(users.at(-1)?.content),
      )?.[1];
      const location = city
        ? ({
            "san francisco": "San Francisco",
            "new york": "New York",
            tokyo: "Tokyo",
          }[city.toLowerCase()] ?? city)
        : "San Francisco";
      return {
        toolCalls: [
          {
            name: "mcp__weather__get_weather",
            arguments: JSON.stringify({ location }),
            id: `call_sdk_weather_${users.length}`,
          },
        ],
      };
    },
  });
}
