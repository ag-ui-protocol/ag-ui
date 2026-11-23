import {
  awaitLLMResponseDone,
  gotoAndAwaitRuntimeInfo,
} from "../../utils/copilot-actions";
import { test, expect } from "../../test-isolation-helper";
import { AgenticGenUIPage } from "../../pages/pydanticAIPages/AgenticUIGenPage";

const PAGE_URL = "/cloudflare-agents/feature/agentic_generative_ui";

// generate_task_steps_generative_ui is a server tool on the Worker: it writes
// the plan into the agent's state and marks each step completed as it goes,
// and the page renders the STATE_SNAPSHOTs.
test.describe("Agent Generative UI Feature", () => {
  test("[Cloudflare Agents] should interact with the chat to get a planner on prompt", async ({
    page,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await gotoAndAwaitRuntimeInfo(page, PAGE_URL);

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await genUIAgent.assertAgentReplyVisible(/Hello/);

    await genUIAgent.sendMessage("Give me a plan to make brownies");
    await expect(genUIAgent.agentPlannerContainer).toBeVisible();
    await genUIAgent.plan();
    await awaitLLMResponseDone(page);
    await expect(genUIAgent.agentPlannerContainer).toContainText(
      "4/4 Complete",
    );
  });

  test("[Cloudflare Agents] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await gotoAndAwaitRuntimeInfo(page, PAGE_URL);

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await genUIAgent.assertAgentReplyVisible(/Hello/);

    await genUIAgent.sendMessage("Go to Mars");

    await expect(genUIAgent.agentPlannerContainer).toBeVisible();
    await genUIAgent.plan();
    await awaitLLMResponseDone(page);
    await expect(genUIAgent.agentPlannerContainer).toContainText(
      "4/4 Complete",
    );
  });
});
