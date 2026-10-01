// Shared suites for the three Claude Managed Agents lanes (Python, TypeScript,
// .NET). The lanes run the same Dojo examples against the same Managed Agents
// fake (apps/dojo/e2e/managed-agents-fake.ts), so one definition per feature is
// registered once per lane from that lane's spec files.

import { test, expect } from "../../test-isolation-helper";
import { awaitLLMResponseDone } from "../../utils/copilot-actions";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { HumanInTheLoopPage } from "../../featurePages/HumanInTheLoopPage";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

export interface ManagedAgentsLane {
  /** Shown in test titles, e.g. "Claude Managed Agents Python". */
  label: string;
  /** The Dojo integration id, e.g. "claude-managed-agents-python". */
  integrationId: string;
  /** The env var the Dojo reads the agent server's URL from, and its default. */
  serverUrlEnv: string;
  defaultServerUrl: string;
}

export const PYTHON: ManagedAgentsLane = {
  label: "Claude Managed Agents Python",
  integrationId: "claude-managed-agents-python",
  serverUrlEnv: "CLAUDE_MANAGED_AGENTS_PYTHON_URL",
  defaultServerUrl: "http://localhost:8025",
};

export const TYPESCRIPT: ManagedAgentsLane = {
  label: "Claude Managed Agents TypeScript",
  integrationId: "claude-managed-agents-typescript",
  serverUrlEnv: "CLAUDE_MANAGED_AGENTS_TYPESCRIPT_URL",
  defaultServerUrl: "http://localhost:8024",
};

export const DOTNET: ManagedAgentsLane = {
  label: "Claude Managed Agents .NET",
  integrationId: "claude-managed-agents-dotnet",
  serverUrlEnv: "CLAUDE_MANAGED_AGENTS_DOTNET_URL",
  defaultServerUrl: "http://localhost:8026",
};

const featureUrl = (lane: ManagedAgentsLane, feature: string) =>
  `/${lane.integrationId}/feature/${feature}`;

export function agenticChatSuite(lane: ManagedAgentsLane): void {
  test(`[${lane.label}] Agentic Chat sends and receives a greeting message`, async ({ page }) => {
    await page.goto(featureUrl(lane, "agentic_chat"));
    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.sendMessage("Hi");
    await chat.assertUserMessageVisible("Hi");
    await chat.assertAgentReplyVisible(/Hello|Hi|hey/i);
  });

  // The fake answers "What is my name?" only from what was posted into the
  // same managed session, so this checks that the adapter maps the thread to
  // one session and posts only the new message each run.
  test(`[${lane.label}] Agentic Chat retains memory of previous questions`, async ({ page }) => {
    test.slow();
    await page.goto(featureUrl(lane, "agentic_chat"));
    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.sendMessage("Hi, my name is Alex");
    await chat.assertUserMessageVisible("Hi, my name is Alex");
    await chat.assertAgentReplyVisible(/Hello|Hi|Alex/i);
    await chat.sendMessage("What is my name?");
    await chat.assertUserMessageVisible("What is my name?");
    await chat.assertAgentReplyVisible(/Your name is Alex/i);
  });
}

export function backendToolRenderingSuite(lane: ManagedAgentsLane): void {
  test(`[${lane.label}] Backend Tool Rendering displays weather cards`, async ({ page }) => {
    test.setTimeout(30000);
    await page.goto(featureUrl(lane, "backend_tool_rendering"));

    await expect(page.getByRole("button", { name: "Weather in San Francisco" })).toBeVisible({
      timeout: 5000,
    });
    await page.getByRole("button", { name: "Weather in San Francisco" }).click();

    const weatherCard = page.getByTestId("weather-card");
    const currentWeatherText = page.getByText("Current Weather");
    try {
      await expect(weatherCard.first()).toBeVisible({ timeout: 10000 });
    } catch {
      await expect(currentWeatherText.first()).toBeVisible({ timeout: 10000 });
    }

    // The card is rendered from the backend get_weather tool's call and
    // result, which the adapter executed and posted back into the session.
    const hasHumidity = await page.getByText("Humidity").first().isVisible().catch(() => false);
    const hasWind = await page.getByText("Wind").first().isVisible().catch(() => false);
    const hasCityName = await page
      .locator("h3")
      .filter({ hasText: /San Francisco/i })
      .first()
      .isVisible()
      .catch(() => false);
    expect(hasHumidity || hasWind || hasCityName).toBeTruthy();
  });
}

export function toolBasedGenUISuite(lane: ManagedAgentsLane): void {
  test(`[${lane.label}] Haiku generation and display verification`, async ({ page }) => {
    await page.goto(featureUrl(lane, "tool_based_generative_ui"));
    const genAIAgent = new ToolBaseGenUIPage(page);
    await expect(genAIAgent.haikuAgentIntro).toBeVisible();
    await genAIAgent.generateHaiku('Generate Haiku for "I will always win"');
    await genAIAgent.checkGeneratedHaiku();
    await genAIAgent.checkHaikuDisplay(page);
  });

  // A frontend tool parks the managed session; the second prompt only gets a
  // haiku if the first call's result reached the session and resumed it.
  test(`[${lane.label}] Haiku generation and UI consistency for two different prompts`, async ({
    page,
  }) => {
    await page.goto(featureUrl(lane, "tool_based_generative_ui"));
    const genAIAgent = new ToolBaseGenUIPage(page);
    await expect(genAIAgent.haikuAgentIntro).toBeVisible();

    await genAIAgent.generateHaiku('Generate Haiku for "I will always win"');
    await genAIAgent.checkGeneratedHaiku();
    await genAIAgent.checkHaikuDisplay(page);

    await genAIAgent.generateHaiku('Generate Haiku for "The moon shines bright"');
    await genAIAgent.checkGeneratedHaiku();
    await genAIAgent.checkHaikuDisplay(page);
  });
}

export function humanInTheLoopSuite(lane: ManagedAgentsLane): void {
  test(`[${lane.label}] Human in the Loop plans steps and resumes after approval`, async ({
    page,
  }) => {
    test.slow();
    const humanInLoop = new HumanInTheLoopPage(page);
    await page.goto(featureUrl(lane, "human_in_the_loop"));
    await humanInLoop.openChat();
    await humanInLoop.sendMessage("Plan a mission to Mars with the first step being Start The Planning");
    await expect(humanInLoop.plan).toBeVisible();
    await humanInLoop.uncheckItem("Start The Planning");
    await humanInLoop.performSteps();
    await awaitLLMResponseDone(page);
    await expect(page.getByText(/followed the steps you selected/i).last()).toBeVisible();
  });
}

/**
 * AG-UI 1.0: the producer declares the protocol version it speaks on
 * RUN_STARTED. Asserted against the agent server directly, since the browser
 * only sees the stream after the Dojo's runtime has re-encoded it.
 */
export function protocolVersionSuite(lane: ManagedAgentsLane): void {
  test(`[${lane.label}] RUN_STARTED declares protocolVersion 1.0`, async ({ request }) => {
    const serverUrl = process.env[lane.serverUrlEnv] ?? lane.defaultServerUrl;
    const response = await request.post(`${serverUrl}/agentic_chat`, {
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      data: {
        threadId: `protocol-version-${Date.now()}`,
        runId: "run-1",
        state: {},
        messages: [{ id: "u1", role: "user", content: "Hi" }],
        tools: [],
        context: [],
        forwardedProps: {},
      },
      timeout: 30000,
    });
    expect(response.status()).toBe(200);
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice("data:".length)) as { type: string; protocolVersion?: string });

    const runStarted = events.find((event) => event.type === "RUN_STARTED");
    expect(runStarted).toBeDefined();
    expect(runStarted?.protocolVersion).toBe("1.0");
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  });
}
