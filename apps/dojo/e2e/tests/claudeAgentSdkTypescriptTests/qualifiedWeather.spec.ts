import { test, expect } from "../../test-isolation-helper";

for (const integration of [
  "claude-agent-sdk-python",
  "claude-agent-sdk-typescript",
]) {
  test(`${integration} renders SDK-qualified weather tools`, async ({
    page,
  }) => {
    await page.route("**/api/copilotkit/**", async (route) => {
      const request = route.request().postDataJSON();
      if (
        request?.method === "info" ||
        route.request().url().endsWith("/info")
      ) {
        await route.fulfill({
          json: {
            version: "1.0.0",
            agents: {
              backend_tool_rendering: {
                name: "backend_tool_rendering",
                description: "Weather fixture",
              },
            },
            audioFileTranscriptionEnabled: false,
          },
        });
        return;
      }
      if (
        request?.method !== "agent/run" &&
        !route.request().url().endsWith("/run")
      ) {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: "",
        });
        return;
      }
      const { threadId, runId } = request.body ?? request;
      const events = [
        // The mocked producer declares its protocol version, as the SDKs do.
        { type: "RUN_STARTED", threadId, runId, protocolVersion: "1.0" },
        {
          type: "TOOL_CALL_START",
          toolCallId: "weather-call",
          toolCallName: "mcp__weather__get_weather",
          parentMessageId: "weather-message",
        },
        {
          type: "TOOL_CALL_ARGS",
          toolCallId: "weather-call",
          delta: JSON.stringify({ location: "San Francisco" }),
        },
        { type: "TOOL_CALL_END", toolCallId: "weather-call" },
        {
          type: "TOOL_CALL_RESULT",
          messageId: "weather-result",
          toolCallId: "weather-call",
          role: "tool",
          content: JSON.stringify({
            temperature: 21,
            conditions: "sunny",
            humidity: 53,
            wind_speed: 8,
            feels_like: 22,
          }),
        },
        { type: "RUN_FINISHED", threadId, runId },
      ];
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: events
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      });
    });
    await page.goto(`/${integration}/feature/backend_tool_rendering`);
    await page
      .getByRole("button", { name: "Weather in San Francisco" })
      .click();
    const card = page.getByTestId("weather-card");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("weather-city")).toHaveText("San Francisco");
    await expect(card).toContainText("21° C");
    await expect(card.getByTestId("weather-humidity")).toContainText("53%");
    await expect(card.getByTestId("weather-wind")).toContainText("8 mph");
    await expect(card.getByTestId("weather-feels-like")).toContainText("22°");
  });
}
