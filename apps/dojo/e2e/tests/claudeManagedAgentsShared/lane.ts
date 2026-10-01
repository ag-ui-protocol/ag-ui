// Shared suites for the three Claude Managed Agents lanes (Python, TypeScript,
// .NET). The lanes run the same Dojo examples against the same Managed Agents
// fake (apps/dojo/e2e/managed-agents-fake.ts), so one definition per feature is
// registered once per lane from that lane's spec files.

import { test, expect } from "../../test-isolation-helper";
import { awaitLLMResponseDone } from "../../utils/copilot-actions";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { BackendToolRenderingPage } from "../../featurePages/BackendToolRenderingPage";
import { HumanInTheLoopPage } from "../../featurePages/HumanInTheLoopPage";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

export interface ManagedAgentsLane {
  /** Shown in test titles, e.g. "Claude Managed Agents Python". */
  label: string;
  /** The Dojo integration id, e.g. "claude-managed-agents-python". */
  integrationId: string;
}

export const PYTHON: ManagedAgentsLane = {
  label: "Claude Managed Agents Python",
  integrationId: "claude-managed-agents-python",
};

export const TYPESCRIPT: ManagedAgentsLane = {
  label: "Claude Managed Agents TypeScript",
  integrationId: "claude-managed-agents-typescript",
};

export const DOTNET: ManagedAgentsLane = {
  label: "Claude Managed Agents .NET",
  integrationId: "claude-managed-agents-dotnet",
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
  // The card's city comes from the get_weather call and its humidity from the
  // example server's tool result, which the adapter posted back into the
  // session.
  test(`[${lane.label}] Backend Tool Rendering displays a weather card`, async ({ page }) => {
    await page.goto(featureUrl(lane, "backend_tool_rendering"));
    const weather = new BackendToolRenderingPage(page);
    await weather.askViaSuggestion("Weather in San Francisco");
    await weather.expectLatestWeatherCard({ city: /San Francisco/i, humidity: 48 });
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
