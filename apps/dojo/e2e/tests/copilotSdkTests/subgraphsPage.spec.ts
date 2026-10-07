import { test, expect } from "./test";
import { SubgraphsPage } from "../../pages/langGraphPages/SubgraphsPage";
import { sendChatMessage } from "../../utils/copilot-actions";
import { captureRuntimeSSE, expectRunFinished } from "../../utils/runtime-sse";
import { parseEventTraceSse } from "../../lib/event-trace-events";

const integrationId = process.env.PLAYWRIGHT_SUITE ?? "copilot-sdk-typescript";
const request = "Help me plan a trip to San Francisco";

test.describe("Subgraphs Travel Agent Feature", () => {
  for (const [flight, hotel] of [["KLM", "Hotel Zoe"], ["United", "The Ritz-Carlton"]]) {
    test(`[GitHub Copilot SDK] persists ${flight} and ${hotel} across native specialists`, async ({ page }) => {
      const travel = new SubgraphsPage(page);
      await page.goto(`/${integrationId}/feature/subgraphs`);
      await travel.openChat();
      const flightsRun = captureRuntimeSSE(page, integrationId, request);
      await sendChatMessage(page, request);
      await expect(page.locator("button.flight-option")).toHaveCount(2);
      await expect(travel.flightsAgentIndicator).toHaveClass(/active/);
      const first = await flightsRun;
      expectRunFinished(first, "flight selection pause");
      expect(first).toContain('"type":"SUBAGENT_STARTED"');
      expect(first).toContain('"type":"interrupt"');

      const hotelsRun = captureRuntimeSSE(page, integrationId, request);
      await page.locator("button.flight-option").filter({ hasText: flight }).click();
      await expect(travel.selectedFlight).toContainText(flight);
      await expect(page.locator("button.hotel-option")).toHaveCount(3);
      await expect(travel.hotelsAgentIndicator).toHaveClass(/active/);
      const second = await hotelsRun;
      expectRunFinished(second, "hotel selection pause");
      expect(second).toContain('"type":"SUBAGENT_FINISHED"');
      expect(second).toContain('"type":"interrupt"');

      const experiencesRun = captureRuntimeSSE(page, integrationId, request);
      await page.locator("button.hotel-option").filter({ hasText: hotel }).click();
      await expect(travel.selectedHotel).toContainText(hotel);
      await expect(travel.selectedFlight).toContainText(flight);
      await expect(travel.experiencesAgentIndicator).toHaveClass(/active/);
      await expect(page.locator(".activity-name")).toHaveText([
        "Pier 39", "Golden Gate Bridge", "Swan Oyster Depot", "Tartine Bakery",
      ]);
      const third = await experiencesRun;
      expectRunFinished(third, "completed itinerary");
      expect(third).not.toContain('"type":"interrupt"');
      const journey = first + second + third;
      const runs = [first, second, third].map(parseEventTraceSse);
      const starts = runs.flat().filter((event) => event.type === "SUBAGENT_STARTED");
      const finishes = runs.flat().filter((event) => event.type === "SUBAGENT_FINISHED");
      expect(new Set(starts.map((event) => event.subagentRunId)).size).toBe(3);
      expect(finishes.map((event) => event.outcome)).toEqual([
        { type: "suspended" }, { type: "success" }, { type: "suspended" },
        { type: "success" }, { type: "success" },
      ]);
      for (const index of [0, 1]) {
        const suspended = runs[index].filter((event) => event.type === "SUBAGENT_FINISHED").at(-1)!;
        const resumed = runs[index + 1].find((event) => event.type === "SUBAGENT_STARTED");
        expect(resumed?.subagentRunId).toBe(suspended.subagentRunId);
      }
      expect(journey).not.toContain('"type":"SUBAGENT_ERROR"');
    });
  }
});
