import { test, expect } from "@playwright/test";
import { AgenticGenUIPage } from "../../pages/langGraphFastAPIPages/AgenticUIGenPage";

test.describe("Agent Generative UI Feature", () => {
  test("[LangGraph FastAPI] should interact with the chat to get a planner on prompt", async ({
    page,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto(
      "https://ag-ui-dojo-nine.vercel.app/langgraph-fastapi/feature/agentic_generative_ui"
    );

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await genUIAgent.sendButton.click();
    await genUIAgent.assertAgentReplyVisible(/Hello/);

    await genUIAgent.sendMessage("give me a recipe for brownies");
    await genUIAgent.sendButton.click();
    await page.waitForTimeout(10000); // Sleep for 10 seconds
    await genUIAgent.plan();
    await genUIAgent.assertAgentReplyVisible(/brownie|recipe/);
  });

  test("[LangGraph FastAPI] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto(
      "https://ag-ui-dojo-nine.vercel.app/langgraph-fastapi/feature/agentic_generative_ui"
    );

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await genUIAgent.sendButton.click();
    await genUIAgent.assertAgentReplyVisible(/Hello/);

    // Replace the button click with direct message
    await genUIAgent.sendMessage("Go to Mars");
    await genUIAgent.sendButton.click();
    await page.waitForTimeout(10000);
    await genUIAgent.plan();
  });
});